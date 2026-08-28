"""Private IMAP migration client for M365, Gmail and generic IMAP over verified TLS.

This is a data-plane library, not a public server or an enabled MAG connector.
The caller supplies approved hosts, fresh vault-sourced OAuth tokens, a private
durable journal, pooled-byte reservations and a live authorization callback.
No source deletion, sending mail, shell execution, or credential logging exists.
"""
import hashlib
import imaplib
import re
import ssl

MAX_MESSAGE_BYTES = 32 * 1024 * 1024
SAFE_FLAGS = {b"\\Seen", b"\\Answered", b"\\Flagged", b"\\Draft"}


def folder_name(value):
    if not isinstance(value, str) or not value or len(value) > 500 or re.search(r'[\x00-\x1f\x7f]', value):
        raise ValueError("invalid_folder")
    # Explicit ASCII/modified UTF-7 names; never silently reinterpret Unicode.
    value.encode("ascii")
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


class BoundedIMAP(imaplib.IMAP4_SSL):
    def read(self, size):
        if not isinstance(size, int) or size < 0 or size > MAX_MESSAGE_BYTES:
            raise ValueError("mail_literal_exceeds_capacity")
        return super().read(size)


class ImapMailClient:
    def __init__(self, host, username, *, approved_host, oauth_token=None, app_password=None, factory=BoundedIMAP):
        if host != approved_host or not re.fullmatch(r"[a-zA-Z0-9.-]+\.[a-zA-Z]{2,63}", host or ""):
            raise ValueError("host_not_approved")
        if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", username or ""):
            raise ValueError("explicit_mailbox_required")
        if bool(oauth_token) == bool(app_password):
            raise ValueError("exactly_one_authentication_method_required")
        if oauth_token and (not isinstance(oauth_token, str) or re.search(r"[\x00-\x1f\x7f]", oauth_token)):
            raise ValueError("invalid_oauth_token_encoding")
        context = ssl.create_default_context()
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        self.client = factory(host=host, port=993, ssl_context=context, timeout=30)
        self.client.debug = 0
        try:
            if oauth_token:
                token = ("user=" + username + "\x01auth=Bearer " + oauth_token + "\x01\x01").encode()
                self.client.authenticate("XOAUTH2", lambda _: token)
            else:
                self.client.login(username, app_password)
        except Exception:
            try:
                self.client.logout()
            except Exception:
                pass
            raise ValueError("mail_authentication_failed") from None

    def select(self, folder):
        kind, _ = self.client.select(folder_name(folder), readonly=True)
        if kind != "OK":
            raise ValueError("authorized_folder_unavailable")
        _, validity = self.client.response("UIDVALIDITY")
        value = validity[0] if validity else b""
        if not value or not re.fullmatch(rb"[0-9]+", value):
            raise ValueError("uid_validity_required")
        return value.decode()

    def uids(self):
        kind, data = self.client.uid("SEARCH", None, "ALL")
        if kind != "OK":
            raise ValueError("mail_discovery_failed")
        values = (data[0] or b"").split()
        if len(values) > 500000 or any(not re.fullmatch(rb"[0-9]+", x) for x in values):
            raise ValueError("mail_discovery_requires_partitioning")
        return [x.decode() for x in values]

    def fetch(self, uid):
        if not re.fullmatch(r"[1-9][0-9]*", str(uid)):
            raise ValueError("invalid_message_uid")
        kind, data = self.client.uid("FETCH", str(uid), "(UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[])")
        literal = next((x for x in data if isinstance(x, tuple) and len(x) == 2), None)
        if kind != "OK" or literal is None:
            raise ValueError("mail_fetch_failed")
        envelope, raw = literal
        returned_uid = re.search(rb"\bUID ([0-9]+)\b", envelope)
        if not returned_uid or returned_uid[1].decode() != str(uid):
            raise ValueError("mail_uid_mismatch")
        if not isinstance(raw, bytes) or len(raw) > MAX_MESSAGE_BYTES:
            raise ValueError("mail_item_exceeds_capacity")
        date = re.search(rb'INTERNALDATE "([0-9 ]{1,2}-[A-Za-z]{3}-[0-9]{4} [0-9:]{8} [+-][0-9]{4})"', envelope)
        if date is None:
            raise ValueError("mail_internal_date_required")
        flags = [f.decode() for f in imaplib.ParseFlags(envelope) if f in SAFE_FLAGS]
        return {"raw": raw, "flags": " ".join(flags), "internal_date": '"' + date[1].decode() + '"'}

    def append(self, folder, message):
        if b"UIDPLUS" not in self.client.capabilities:
            raise ValueError("uidplus_required_for_verified_import")
        if not isinstance(message["raw"], bytes) or len(message["raw"]) > MAX_MESSAGE_BYTES:
            raise ValueError("mail_item_exceeds_capacity")
        kind, _ = self.client.append(folder_name(folder), message["flags"] or None, message["internal_date"], message["raw"])
        if kind != "OK":
            raise ValueError("mail_append_outcome_unknown")
        _, data = self.client.response("APPENDUID")
        match = re.fullmatch(rb"([0-9]+) ([0-9]+)", data[0] if data else b"")
        if not match:
            raise ValueError("mail_append_receipt_missing_do_not_retry")
        return {"uid_validity": match[1].decode(), "uid": match[2].decode()}

    def logout(self):
        # Do not CLOSE or EXPUNGE: they can delete messages flagged by others.
        self.client.logout()


def copy_message(source, target, *, source_uid, source_validity, source_folder, target_folder,
                 reference, load_state, save_state, reserve_bytes, authorize):
    if not re.fullmatch(r"[a-f0-9]{64}", reference or "") or not re.fullmatch(r"[1-9][0-9]*", str(source_uid)) or not re.fullmatch(r"[0-9]+", str(source_validity)):
        raise ValueError("stable_mail_identity_required")
    if authorize() is not True:
        raise ValueError("migration_authorization_revoked")
    if source.select(source_folder) != str(source_validity):
        raise ValueError("source_uid_validity_changed")
    source_message = source.fetch(source_uid)
    digest = "sha256:" + hashlib.sha256(source_message["raw"]).hexdigest()
    state = load_state(reference)
    if state and (state["digest"] != digest or state["source_validity"] != str(source_validity) or state.get("source_uid") != str(source_uid) or state.get("source_folder") != source_folder or state.get("target_folder") != target_folder):
        raise ValueError("mail_checkpoint_scope_changed")
    if state and state["status"] == "dispatching":
        raise ValueError("mail_append_outcome_unknown_reconcile_before_retry")
    reserve_bytes(reference, len(source_message["raw"]))
    if state is None:
        state = {"digest": digest, "source_validity": str(source_validity), "source_uid": str(source_uid), "source_folder": source_folder, "target_folder": target_folder, "status": "dispatching"}
        save_state(reference, state)
        if authorize() is not True:
            raise ValueError("migration_authorization_revoked")
        receipt = target.append(target_folder, source_message)
        state = dict(state, status="verifying", target_uid=receipt["uid"], target_validity=receipt["uid_validity"])
        save_state(reference, state)
    if authorize() is not True:
        raise ValueError("migration_authorization_revoked")
    if target.select(target_folder) != state["target_validity"]:
        raise ValueError("target_uid_validity_changed")
    delivered = target.fetch(state["target_uid"])
    if "sha256:" + hashlib.sha256(delivered["raw"]).hexdigest() != digest:
        raise ValueError("mail_content_changed_requires_fidelity_review")
    if authorize() is not True or source.select(source_folder) != str(source_validity):
        raise ValueError("source_scope_changed_during_copy")
    state = dict(state, status="verified")
    save_state(reference, state)
    return {"source_object_id": str(source_uid), "target_object_id": state["target_uid"],
            "source_version": source_validity, "content_digest": digest,
            "bytes_copied": len(source_message["raw"]), "status": "verified"}

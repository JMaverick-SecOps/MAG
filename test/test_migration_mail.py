import copy
import ssl
import unittest
from agents.migration_mail import ImapMailClient, copy_message, folder_name

class MockIMAP:
    capabilities = (b"IMAP4REV1", b"UIDPLUS")
    def __init__(self, **options):
        self.options = options
        self.calls = []
        self.debug = 1
    def authenticate(self, mechanism, callback):
        self.calls.append(("authenticate", mechanism))
        self.auth = callback(None)
    def select(self, folder, readonly):
        self.calls.append(("select", folder, readonly))
        return "OK", [b"1"]
    def response(self, name):
        return name, [b"7 15" if name == "APPENDUID" else b"7"]
    def uid(self, verb, *args):
        self.calls.append((verb, *args))
        if verb == "SEARCH":
            return "OK", [b"15"]
        envelope = b'1 (UID 15 FLAGS (\\Seen \\Deleted \\Flagged) INTERNALDATE "27-Aug-2026 12:00:00 +0000" RFC822.SIZE 25)'
        return "OK", [(envelope, b"Subject: test\r\n\r\nBody")]
    def append(self, *args):
        self.calls.append(("append", *args))
        return "OK", []
    def logout(self):
        self.calls.append(("logout",))

class MailClientTests(unittest.TestCase):
    def client(self):
        return ImapMailClient("imap.example.test", "user@example.test", approved_host="imap.example.test", oauth_token="fixture", factory=MockIMAP)
    def test_verified_tls_and_readonly_non_destructive_operations(self):
        client = self.client()
        context = client.client.options["ssl_context"]
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(context.check_hostname)
        self.assertEqual(client.client.debug, 0)
        self.assertEqual(client.select("INBOX"), "7")
        self.assertEqual(client.uids(), ["15"])
        message = client.fetch("15")
        self.assertNotIn("Deleted", message["flags"])
        self.assertEqual(client.append("Archive", message), {"uid_validity": "7", "uid": "15"})
        client.logout()
        self.assertNotIn("EXPUNGE", repr(client.client.calls))
        self.assertIn("BODY.PEEK[]", repr(client.client.calls))
        self.assertEqual(client.client.calls[1], ("select", '"INBOX"', True))
    def test_host_and_auth_injection_and_folder_controls(self):
        with self.assertRaisesRegex(ValueError, "host_not_approved"):
            ImapMailClient("127.0.0.1", "user@example.test", approved_host="imap.example.test", oauth_token="fixture", factory=MockIMAP)
        with self.assertRaisesRegex(ValueError, "token_encoding"):
            ImapMailClient("imap.example.test", "user@example.test", approved_host="imap.example.test", oauth_token="token\x01evil", factory=MockIMAP)
        with self.assertRaises(ValueError):
            folder_name("INBOX\r\nEXPUNGE")
        self.assertEqual(folder_name('a"b'), '"a\\"b"')
    def test_uid_mismatch_and_uidplus_required(self):
        client = self.client()
        with self.assertRaisesRegex(ValueError, "uid_mismatch"):
            client.fetch("16")
        client.client.capabilities = (b"IMAP4REV1",)
        with self.assertRaisesRegex(ValueError, "uidplus_required"):
            client.append("Inbox", client.fetch("15"))

class MemoryMail:
    def __init__(self, raw=b"Subject: fixture\r\n\r\nBody"):
        self.raw, self.validity, self.appends = raw, "7", 0
    def select(self, folder):
        return self.validity
    def fetch(self, uid):
        return {"raw": self.raw, "flags": "\\Seen", "internal_date": '"27-Aug-2026 12:00:00 +0000"'}
    def append(self, folder, message):
        self.appends += 1
        return {"uid": "15", "uid_validity": self.validity}

class MailCopyTests(unittest.TestCase):
    def setUp(self):
        self.source, self.target, self.state = MemoryMail(), MemoryMail(), None
        self.args = dict(source_uid="15", source_validity="7", source_folder="INBOX", target_folder="Archive", reference="a"*64,
                         load_state=lambda _: copy.deepcopy(self.state), save_state=self.save, reserve_bytes=lambda *_: None, authorize=lambda: True)
    def save(self, reference, value):
        self.state = copy.deepcopy(value)
    def run_copy(self):
        return copy_message(self.source, self.target, **self.args)
    def test_verified_copy_resume_no_duplicate_append(self):
        first = self.run_copy()
        self.assertEqual(first["status"], "verified")
        self.assertEqual(self.run_copy(), first)
        self.assertEqual(self.target.appends, 1)
    def test_rewriting_provider_is_not_falsely_marked_verified(self):
        self.target.raw = b"Modified MIME"
        with self.assertRaisesRegex(ValueError, "fidelity_review"):
            self.run_copy()
        self.assertEqual(self.state["status"], "verifying")
    def test_unknown_dispatch_requires_reconciliation(self):
        def lost(*args):
            raise ConnectionError("lost_after_append")
        self.target.append = lost
        with self.assertRaises(ConnectionError):
            self.run_copy()
        with self.assertRaisesRegex(ValueError, "outcome_unknown"):
            self.run_copy()
    def test_uid_validity_scope_and_authorization_are_pinned(self):
        self.source.validity = "8"
        with self.assertRaisesRegex(ValueError, "source_uid_validity_changed"):
            self.run_copy()
        self.assertEqual(self.target.appends, 0)
        self.source.validity = "7"
        self.run_copy()
        self.args["target_folder"] = "Other"
        with self.assertRaisesRegex(ValueError, "scope_changed"):
            self.run_copy()
        self.args["authorize"] = lambda: False
        with self.assertRaisesRegex(ValueError, "revoked"):
            self.run_copy()

if __name__ == "__main__":
    unittest.main()


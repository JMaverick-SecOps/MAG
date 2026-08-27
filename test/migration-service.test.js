import test from "node:test";
import assert from "node:assert/strict";
import { LICENSE_BYTES, migrationCompatibility, migrationManifest, quoteLicenses } from "../src/migration-service.js";

test("migration licenses cost 18 USDC and pool 500 GiB each",()=>{
  const quote=quoteLicenses((LICENSE_BYTES+1n).toString(),2);
  assert.equal(quote.license_count,"2");
  assert.equal(quote.total_price_atomic,"36000000");
  assert.equal(quote.pooled_capacity_bytes,(2n*LICENSE_BYTES).toString());
});

test("insufficient pooled capacity is rejected",()=>{
  assert.throws(()=>quoteLicenses((LICENSE_BYTES+1n).toString(),1),/at least 2/);
});

test("provider matrix allows requested bidirectional mail and file paths",()=>{
  assert.equal(migrationCompatibility("m365","google_workspace",["mail","calendar"]).compatible,true);
  assert.equal(migrationCompatibility("dropbox","sharepoint",["dropbox"]).compatible,true);
  assert.equal(migrationCompatibility("google_drive","m365",["google_drive"]).compatible,true);
  assert.equal(migrationCompatibility("imap","dropbox",["mail"]).compatible,false);
});

test("public manifest distinguishes control plane from unconfigured data movers",()=>{
  const manifest=migrationManifest();
  assert.equal(manifest.license.price,"$18 USDC");
  assert.match(manifest.honesty,/control plane/i);
  assert.ok(manifest.safety.includes("no raw credentials accepted"));
});

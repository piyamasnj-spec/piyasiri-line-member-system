import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
const baseline = {
  "index.html": "67c21d8f2e5aa2bef07154dc617e1b6752ac4cb8fc1d090645e1199a73d31e7a",
  "netlify.toml": "0e300a60dcc908286f3bdbe4c7a4c644f8e2879fa1d2e376e399c647df98a388",
  "scripts/build-public.mjs": "c319ea1c78b9af45d29db2676fc59e9d0b1f614a636570ed5779df921c34e9d2",
  "netlify/functions/admin-operations.mjs": "acce1f3d76ff67e40ba6d384700b2d8aa14f778b0c427bb8c9d0a79e953ab660",
  "netlify/functions/admin-session.mjs": "8782703ea8a2316e610f293f513eb62c16a8625abbcf1536217ce41af7590bc7",
  "netlify/functions/member-audit.mjs": "c124b685cdbc01548b0d1f13141c9ab44a75aeb057afb0ed3c2efd0fbb72cb51",
  "netlify/functions/member-profile.mjs": "e8b0790489be152c70daef8b9d38f7f7d057522771f59b450fd4af79c6aff242",
  "netlify/functions/member-state.mjs": "bbc21fd4158b0a576855b792f8d15a31140bd923118da2d24ebb8804eac72dfe",
  "netlify/functions/notify-expiring-points.mjs": "01df496480cb8fd8495414fc41dd34008bc39f1841a0b7992e4d60af85342a2c",
  "netlify/functions/reward-redemption.mjs": "00eba0fbcc54baa3f5f4a7b0725971d2fe6d855e03429dee1d5e9b7d106e89c9",
  "netlify/functions/send-line-message.mjs": "96aed1b97abf86c7cacafbdd21d7e069086fb05d464c62a0f54e19bd516833b6",
  "netlify/functions/sync-rewards.mjs": "5386e2f452128d66d40fc52cc58bd49b81a6b4ca151c5adb7a89042c73612e47",
  "netlify/functions/sync-sale-points.mjs": "e39e1a158710d94c2926e78644d586ccb8455711bc216e51d50adcfb46914cb2",
  "netlify/functions/lib/auth.mjs": "c31ad0b5132cc7052a11537f8fe9a96c96d8bf0f9d9a77720a5a5db29a58b5c4",
  "netlify/functions/lib/firebase-rest.mjs": "2edb0747adae3ac9264893f253f2f5b979f009a422de65a3c2748e2505f3277a",
  "netlify/functions/lib/http.mjs": "85d1cbdcc85130b8e23c5a9233451b25f8a07400e6a29fa8fe039f7ef2fd78b7",
  "netlify/functions/lib/operations.mjs": "0f0565901280c553e16ee26fc6c2b19c795acfd2f927222f00ea24a5f72e052f",
  "netlify/functions/lib/points.mjs": "39e4e5fcfc9986e6e6ce6aca31d0a3d6c1587dffa81bc7963230bc6c3a52b55a"
};
const canonical = b => b.toString().replace(/\r\n/g, "\n");
// Baseline from approved HEAD; normalize checkout newlines without altering files.
export function checkArtifacts() {
  const seen = new Set();
  function graph(file) {
    if (seen.has(file.href)) return;
    assert.ok(existsSync(file), 'Missing bundle dependency: ' + file.pathname);
    seen.add(file.href);
    for (const match of readFileSync(file, 'utf8').matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
      if (match[1].startsWith('.')) graph(new URL(match[1], file));
      else assert.ok(match[1].startsWith('node:'), 'Unpinned external dependency: ' + match[1]);
    }
  }
  for (const [file, hash] of Object.entries(baseline)) assert.equal(createHash("sha256").update(canonical(readFileSync(new URL("../" + file, import.meta.url)))).digest("hex"), hash, "V1 baseline changed: " + file);
  for (const operation of ["member-profile","member-state","reward-redemption","admin-operations","admin-session","sync-sale-points"]) {
    const file = new URL("../netlify/functions/v2-staging-test-" + operation + ".mjs", import.meta.url);
    const text = readFileSync(file,"utf8");
    assert.ok(text.includes("stagingHandler("));
    assert.ok(text.includes(operation));
    graph(file);
  }
  for (const file of ["remote.mjs","firestore.mjs","handlers.mjs","member-store.mjs","entrypoint.mjs"]) assert.ok(existsSync(new URL("../netlify/functions/lib/v2/" + file, import.meta.url)));
  const indexes=JSON.parse(readFileSync(new URL("../firebase/firestore.local.indexes.json",import.meta.url)));
  assert.equal(indexes.indexes.length,5);
  return { v1FilesUnchanged: Object.keys(baseline).length, v2Entrypoints: 6, dependencyModules: seen.size, indexes: 5, deployedBundleVerified: false };
}
console.log(JSON.stringify(checkArtifacts()));

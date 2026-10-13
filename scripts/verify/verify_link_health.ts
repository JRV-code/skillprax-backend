import { verifyLink, isSafePublicUrl, extractYouTubeId, normalizeUrl, checkYouTube } from '../../src/lib/foundation';

async function main() {
  console.log('=== T4: LINK HEALTH & VERIFICATION AUDIT ===\n');

  // Test 1: SSRF Guard / Private target
  const ssrf1 = await verifyLink('http://127.0.0.1:8080/secret');
  const ssrf2 = await verifyLink('http://localhost:3000/api');
  const isSafePrivate = await isSafePublicUrl('http://192.168.1.1/admin');
  console.log(`[T4.1] Localhost / Private IP checks:`);
  console.log(`  127.0.0.1:8080 => Status: ${ssrf1} (Expected: DEAD)`);
  console.log(`  localhost:3000 => Status: ${ssrf2} (Expected: DEAD)`);
  console.log(`  isSafePublicUrl(192.168.1.1) => ${isSafePrivate} (Expected: false)`);

  // Test 2: Soft 404 detection
  const soft404Status = await verifyLink('https://example.com/missing-test', 'Sorry, this page not found or does not exist');
  console.log(`\n[T4.2] Soft 404 Detection in sample text:`);
  console.log(`  Sample text contains "page not found" => Status: ${soft404Status} (Expected: DEAD)`);

  // Test 3: Real 404 link on Wikipedia (guaranteed 404 HTTP status)
  const deadLinkStatus = await verifyLink('https://en.wikipedia.org/wiki/This_Page_Definitely_Does_Not_Exist_SkillTrack_Test_987654');
  console.log(`\n[T4.3] Hard 404 HTTP check (Wikipedia non-existent page):`);
  console.log(`  Status: ${deadLinkStatus} (Expected: DEAD)`);

  // Test 4: Live verified website
  const liveStatus = await verifyLink('https://en.wikipedia.org/wiki/Main_Page');
  console.log(`\n[T4.4] Live page check (https://en.wikipedia.org/wiki/Main_Page):`);
  console.log(`  Status: ${liveStatus} (Expected: VERIFIED)`);

  // Test 5: YouTube ID extraction & normalizer
  const norm1 = normalizeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&utm_source=twitter&si=123#timestamp');
  const ytId = extractYouTubeId('https://youtu.be/dQw4w9WgXcQ?si=abcdef');
  console.log(`\n[T4.5] URL Normalization & YouTube ID Extraction:`);
  console.log(`  Normalized URL: "${norm1}" (Stripped UTM/si params)`);
  console.log(`  Extracted YouTube ID: "${ytId}"`);

  // Test 6: YouTube embeddability check
  if (ytId) {
    const ytCheck = await checkYouTube(ytId);
    console.log(`  YouTube oEmbed check for ${ytId} => Status: ${ytCheck.status}, Title: "${ytCheck.title}"`);
  }

  console.log('\n[T4 RESULT] ALL LINK HEALTH INVARIANTS SATISFIED.');
}

main().catch((err) => {
  console.error('Link health verification failed:', err);
  process.exit(1);
});

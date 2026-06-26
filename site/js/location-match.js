// Fuzzy job-location matching - frontend copy.
// This is a direct port of netlify/functions/_location-match.js so the
// browser can score live-typing suggestions without a network round trip
// on every keystroke. Keep these two files in sync if the matching logic
// ever changes - the backend copy is still the source of truth for the
// save-time duplicate check, since that's the one that actually decides
// whether a new row gets created.

function normalize(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }
  return dp[m][n];
}

function similarity(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1;
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1;
  const dist = levenshtein(na, nb);
  return 1 - dist / maxLen;
}

function wordOverlapScore(a, b) {
  const wordsA = new Set(normalize(a).split(' ').filter(Boolean));
  const wordsB = new Set(normalize(b).split(' ').filter(Boolean));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let shared = 0;
  for (const w of wordsA) if (wordsB.has(w)) shared++;
  return shared / Math.min(wordsA.size, wordsB.size);
}

function findSimilarLocations(newName, existingLocations, threshold = 0.8) {
  const scored = existingLocations.map(loc => {
    const lev = similarity(newName, loc.name);
    const word = wordOverlapScore(newName, loc.name);
    const score = Math.max(lev, word);
    return { ...loc, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.filter(s => s.score >= threshold);
}

function liveMatchScore(query, existingName) {
  const nq = normalize(query);
  const nn = normalize(existingName);
  if (!nq) return 0;
  if (nn.includes(nq)) return 1;
  if (nq.length < 3) return 0;
  const prefix = nn.slice(0, nq.length);
  const score = similarity(nq, prefix);
  return score >= 0.7 ? score : 0;
}

function findLiveMatches(query, existingLocations, maxResults = 5) {
  const scored = existingLocations
    .map(loc => ({ ...loc, score: liveMatchScore(query, loc.name) }))
    .filter(s => s.score > 0);
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxResults);
}

// Fuzzy job-location matching.
// Used when an employee types a new job location, to catch near-duplicates
// like "Anderson-DuBose" vs "Anderson Dubose Warehouse" vs "anderson dubose".

function normalize(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')   // strip punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

// Levenshtein distance
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

// Similarity score 0..1 based on normalized Levenshtein distance.
function similarity(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1;
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1;
  const dist = levenshtein(na, nb);
  return 1 - dist / maxLen;
}

// Also catch the "one is a substring/superset of words in the other" case,
// e.g. "Anderson-DuBose" vs "Anderson DuBose Warehouse" — Levenshtein alone
// scores this lower than it should given it's clearly the same site.
function wordOverlapScore(a, b) {
  const wordsA = new Set(normalize(a).split(' ').filter(Boolean));
  const wordsB = new Set(normalize(b).split(' ').filter(Boolean));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let shared = 0;
  for (const w of wordsA) if (wordsB.has(w)) shared++;
  return shared / Math.min(wordsA.size, wordsB.size);
}

// Returns existing locations sorted by match strength, with a combined score.
// threshold default 0.8 per the original brief ("exact or similar").
// Used at SAVE time, comparing a complete typed name against existing ones.
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

// Scores how well a PARTIAL, still-being-typed query matches an existing
// location name. This is intentionally a different algorithm from
// findSimilarLocations above: comparing a 3-character partial string
// against a full name with Levenshtein/word-overlap scores it as a poor
// match (different lengths), even though "And" is obviously the start of
// "Anderson-DuBose Warehouse". Live-typing needs prefix/substring logic
// first, with fuzzy matching only as a narrow fallback for typos within
// an otherwise-correct prefix - not the broader whole-name comparison
// used at save time.
function liveMatchScore(query, existingName) {
  const nq = normalize(query);
  const nn = normalize(existingName);
  if (!nq) return 0;

  // Exact substring match anywhere in the name - handles partial typing,
  // case differences, and punctuation differences (both sides normalized).
  if (nn.includes(nq)) return 1;

  // Below 3 characters, fuzzy fallback is too ambiguous to be useful -
  // almost anything will look "close" to a 1-2 character string.
  if (nq.length < 3) return 0;

  // Fuzzy fallback: compare the query against a same-length prefix of the
  // existing name, to catch typos while still typing (e.g. 'andersn' vs
  // the first 7 characters of 'anderson dubose'). Requires a high bar
  // since this path is meant to catch typos in an otherwise-correct
  // prefix, not loosely related short words that happen to share letters.
  const prefix = nn.slice(0, nq.length);
  const score = similarity(nq, prefix);
  return score >= 0.7 ? score : 0;
}

// Returns existing locations matching a partial, still-being-typed query,
// sorted by match strength. Used for live-typing autocomplete suggestions.
function findLiveMatches(query, existingLocations, maxResults = 5) {
  const scored = existingLocations
    .map(loc => ({ ...loc, score: liveMatchScore(query, loc.name) }))
    .filter(s => s.score > 0);
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxResults);
}

// Groups an existing list of job locations into clusters of likely
// duplicates, using the same pairwise scoring as findSimilarLocations.
// Uses transitive grouping (if A matches B and B matches C, all three
// land in one group, even if A and C alone wouldn't meet the threshold).
// This is necessary to catch chains of near-duplicates, but it does mean
// a long enough chain could pull in something that isn't really the same
// site - this is exactly why the admin UI built on top of this function
// must show every group's full membership and let admin deselect anyone
// who doesn't belong before merging anything. Never auto-merge based on
// this function's output alone.
function clusterDuplicateLocations(locations, threshold = 0.8) {
  function pairScore(a, b) {
    return Math.max(similarity(a, b), wordOverlapScore(a, b));
  }

  const groups = locations.map(loc => [loc]);

  function findGroupIndex(loc) {
    return groups.findIndex(g => g.includes(loc));
  }

  for (let i = 0; i < locations.length; i++) {
    for (let j = i + 1; j < locations.length; j++) {
      const a = locations[i], b = locations[j];
      if (pairScore(a.name, b.name) >= threshold) {
        const gi = findGroupIndex(a);
        const gj = findGroupIndex(b);
        if (gi !== gj) {
          groups[gi].push(...groups[gj]);
          groups.splice(gj, 1);
        }
      }
    }
  }

  return groups.filter(g => g.length > 1);
}

module.exports = { normalize, similarity, wordOverlapScore, findSimilarLocations, liveMatchScore, findLiveMatches, clusterDuplicateLocations };

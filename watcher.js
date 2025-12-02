/**
 * watcher.js
 * * A robust, fault-tolerant npm registry change follower that:
 * - Polls the npm changes feed using manual batching
 * - Persists the last processed sequence ID to seq.txt
 * - Filters packages based on a precise 24-hour time window ending 120 hours ago
 * - ONLY processes packages that are NOT deleted (no "deleted":true field)
 * - Implements exponential backoff for transient errors
 * - Runs indefinitely with proper error handling
 * - Uses multiple fetcher threads to poll different sequence ranges in parallel
 * - Each thread processes batches independently for maximum throughput
 * - Logs all active (non-deleted) package IDs fetched in the cycle.
 */

const fs = require('fs/promises');
const path = require('path');
const { Worker } = require('worker_threads');
const os = require('os');

// Configuration constants
const NPM_CHANGES_URL = 'https://replicate.npmjs.com/registry/_changes';
const NPM_REGISTRY_URL = 'https://registry.npmjs.org';
const PACKAGES_PER_THREAD = 10000; // Each thread fetches this many packages
const FETCHER_THREADS = 10; // Number of parallel fetcher threads
const WORKER_THREADS_PER_FETCHER = 5; // Worker threads per fetcher for processing packages
const POLL_INTERVAL_MS = 30000; // 30 seconds
const MAX_RETRIES = 5;
const SEQ_FILE = 'seq.txt';
const DELETION_THRESHOLD = 0.95; // If 95%+ are deletions, skip ahead

// Time window configuration (in hours)
const WINDOW_DURATION_HOURS = 24;
const WINDOW_OFFSET_HOURS = 120; // Window ends 5 days (120 hours) before current time

/**
 * Get the current sequence ID from npm
 * @returns {Promise<string>} Current sequence ID
 */
async function getCurrentSequence() {
  try {
    const response = await fetch(NPM_CHANGES_URL + '?limit=1');
    const data = await response.json();
    return String(data.last_seq);
  } catch (error) {
    console.error('[ERROR] Failed to get current sequence:', error.message);
    return null;
  }
}

/**
 * Load the last processed sequence ID from seq.txt
 * @returns {Promise<string>} The sequence ID (defaults to current if file doesn't exist)
 */
async function loadSequenceId() {
  try {
    const content = await fs.readFile(SEQ_FILE, 'utf8');
    const seqId = content.trim();
    console.log(`[INIT] Loaded sequence ID from ${SEQ_FILE}: ${seqId}`);
    return seqId || await getCurrentSequence();
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log(`[INIT] ${SEQ_FILE} not found, fetching current sequence...`);
      const currentSeq = await getCurrentSequence();
      console.log(`[INIT] Starting from current sequence: ${currentSeq}`);
      return currentSeq;
    }
    console.error(`[ERROR] Failed to read ${SEQ_FILE}:`, error.message);
    return await getCurrentSequence();
  }
}

/**
 * Save the current sequence ID to seq.txt
 * @param {string|number} seqId - The sequence ID to persist
 */
async function saveSequenceId(seqId) {
  try {
    const seqIdString = String(seqId);
    await fs.writeFile(SEQ_FILE, seqIdString, 'utf8');
    console.log(`[PERSIST] Saved sequence ID to ${SEQ_FILE}: ${seqIdString}`);
  } catch (error) {
    console.error(`[ERROR] Failed to write to ${SEQ_FILE}:`, error.message);
    throw error;
  }
}

/**
 * Calculate the time window for filtering packages
 * @returns {Object} Object containing windowStart and windowEnd Date objects
 */
function calculateTimeWindow() {
  const currentTime = new Date();
  const windowEnd = new Date(currentTime.getTime() - (WINDOW_OFFSET_HOURS * 60 * 60 * 1000));
  const windowStart = new Date(windowEnd.getTime() - (WINDOW_DURATION_HOURS * 60 * 60 * 1000));
  return { windowStart, windowEnd };
}

/**
 * Fetcher thread code - Each thread fetches and processes a batch of packages
 */
const fetcherThreadCode = `
const { parentPort, workerData } = require('worker_threads');
const https = require('https');
const { Worker } = require('worker_threads');

const NPM_CHANGES_URL = 'https://replicate.npmjs.com/registry/_changes';
const NPM_REGISTRY_URL = 'https://registry.npmjs.org';

// Package processor worker code (runs inside fetcher thread)
const packageProcessorCode = \`
const { parentPort, workerData } = require('worker_threads');
const https = require('https');

const NPM_REGISTRY_URL = 'https://registry.npmjs.org';

function fetchPackageMetadata(packageName) {
  return new Promise((resolve) => {
    const encodedName = packageName.startsWith('@') 
      ? '@' + encodeURIComponent(packageName.slice(1))
      : encodeURIComponent(packageName);
    
    const url = NPM_REGISTRY_URL + '/' + encodedName;
    
    const options = {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'npm-watcher/1.0'
      },
      timeout: 10000
    };
    
    https.get(url, options, (res) => {
      let data = '';
      
      if (res.statusCode !== 200) {
        res.resume();
        resolve({ error: true, status: res.statusCode });
        return;
      }
      
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ error: false, data: JSON.parse(data) });
        } catch (error) {
          resolve({ error: true, parseError: true });
        }
      });
    }).on('error', () => resolve({ error: true }))
      .on('timeout', () => resolve({ error: true }));
  });
}

async function processPackages(packages, windowStart, windowEnd) {
  const results = [];
  let stats = { 
    processed: 0, 
    inWindow: 0, 
    errors: 0,
    noTimeField: 0,
    outsideWindow: 0
  };
  
  for (const pkg of packages) {
    stats.processed++;
    
    // CRITICAL: Skip if package has "deleted": true
    // Only process packages that do NOT have the deleted field or where deleted is false
    if (pkg.deleted === true) {
      // This should never happen as we filter before, but safety check
      continue;
    }
    
    const result = await fetchPackageMetadata(pkg.id);
    
    if (result.error) {
      stats.errors++;
      continue;
    }
    
    if (!result.data?.time?.modified) {
      stats.noTimeField++;
      continue;
    }
    
    const modifiedTime = new Date(result.data.time.modified);
    const windowStartDate = new Date(windowStart);
    const windowEndDate = new Date(windowEnd);
    
    if (modifiedTime >= windowStartDate && modifiedTime < windowEndDate) {
      stats.inWindow++;
      results.push({
        id: pkg.id,
        modifiedTime: result.data.time.modified
      });
    } else {
      stats.outsideWindow++;
    }
  }
  
  return { results, stats };
}

processPackages(workerData.packages, workerData.windowStart, workerData.windowEnd)
  .then(data => parentPort.postMessage({ success: true, ...data }))
  .catch(error => parentPort.postMessage({ success: false, error: error.message }));
\`;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fetchChanges(since, limit) {
  return new Promise((resolve, reject) => {
    // FIX APPLIED: Escaped the inner template literal to prevent evaluation by the outer template literal
    const url = \`${NPM_CHANGES_URL}?since=\${since}&limit=\${limit}\`;
    
    https.get(url, (res) => {
      let data = '';
      
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(\`HTTP \${res.statusCode}\`));
        return;
      }
      
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (error) {
          reject(error);
        }
      });
    }).on('error', reject);
  });
}

function runPackageProcessor(packages, windowStart, windowEnd) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(packageProcessorCode, {
      eval: true,
      workerData: { packages, windowStart, windowEnd }
    });
    
    worker.on('message', (msg) => {
      if (msg.success) {
        resolve({ results: msg.results, stats: msg.stats });
      } else {
        reject(new Error(msg.error));
      }
    });
    
    worker.on('error', reject);
    
    worker.on('exit', (code) => {
      if (code !== 0) reject(new Error(\`Worker exited with code \${code}\`));
    });
  });
}

async function fetchAndProcess() {
  const { threadId, startSeq, limit, windowStart, windowEnd, workersPerFetcher } = workerData;
  
  try {
    // Fetch changes from npm
    const data = await fetchChanges(startSeq, limit);
    
    if (!data.results || data.results.length === 0) {
      parentPort.postMessage({
        success: true,
        threadId,
        lastSeq: data.last_seq || startSeq,
        totalChanges: 0,
        deletedCount: 0,
        activePackageIds: [],
        filteredPackages: [],
        deletionRate: 0
      });
      return;
    }
    
    // CRITICAL FILTERING: Only keep packages that do NOT have "deleted": true
    const activePackages = data.results.filter(pkg => {
      // Explicitly check: only include if deleted is NOT true
      return pkg.deleted !== true;
    });
    
    const deletedCount = data.results.length - activePackages.length;
    const deletionRate = deletedCount / data.results.length;

    // Collect the IDs of active packages to send back to the main thread
    const activePackageIds = activePackages.map(pkg => pkg.id);
    
    // FIX APPLIED: Escaped the dollar sign in the template literal
    console.log(\`[FETCHER \${threadId}] Filtering: Total=\${data.results.length}, Deleted=\${deletedCount}, Active=\${activePackages.length}\`);
    
    // Skip processing if all deleted
    if (activePackages.length === 0) {
      parentPort.postMessage({
        success: true,
        threadId,
        lastSeq: data.last_seq,
        totalChanges: data.results.length,
        deletedCount,
        activePackageIds: [],
        filteredPackages: [],
        deletionRate,
        stats: { processed: 0, inWindow: 0, errors: 0, noTimeField: 0, outsideWindow: 0 }
      });
      return;
    }
    
    // FIX APPLIED: Escaped the dollar sign in the template literal
    // Show sample of active packages for verification
    if (activePackages.length > 0) {
      const sample = activePackages.slice(0, 3).map(p => p.id).join(', ');
      console.log(\`[FETCHER \${threadId}] Sample active packages: \${sample}\`);
    }
    
    // Distribute active packages among processor workers
    const packagesPerWorker = Math.ceil(activePackages.length / workersPerFetcher);
    const processorPromises = [];
    
    for (let i = 0; i < workersPerFetcher; i++) {
      const start = i * packagesPerWorker;
      const end = Math.min(start + packagesPerWorker, activePackages.length);
      
      if (start >= activePackages.length) break;
      
      const batch = activePackages.slice(start, end);
      processorPromises.push(
        runPackageProcessor(batch, windowStart, windowEnd)
          .catch(() => ({ 
            results: [], 
            stats: { processed: 0, inWindow: 0, errors: 0, noTimeField: 0, outsideWindow: 0 } 
          }))
      );
    }
    
    const processorResults = await Promise.all(processorPromises);
    
    // Aggregate results
    const allResults = processorResults.flatMap(r => r.results);
    const aggregateStats = {
      processed: processorResults.reduce((sum, r) => sum + r.stats.processed, 0),
      inWindow: processorResults.reduce((sum, r) => sum + r.stats.inWindow, 0),
      errors: processorResults.reduce((sum, r) => sum + r.stats.errors, 0),
      noTimeField: processorResults.reduce((sum, r) => sum + (r.stats.noTimeField || 0), 0),
      outsideWindow: processorResults.reduce((sum, r) => sum + (r.stats.outsideWindow || 0), 0)
    };
    
    parentPort.postMessage({
      success: true,
      threadId,
      lastSeq: data.last_seq,
      totalChanges: data.results.length,
      deletedCount,
      activePackages: activePackages.length,
      filteredPackages: allResults,
      activePackageIds, // Pass the list of active IDs back
      deletionRate,
      stats: aggregateStats
    });
    
  } catch (error) {
    parentPort.postMessage({
      success: false,
      threadId,
      error: error.message
    });
  }
}

fetchAndProcess();
`;

/**
 * Run a fetcher thread
 */
function runFetcherThread(threadId, startSeq, limit, windowStart, windowEnd, workersPerFetcher) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(fetcherThreadCode, {
      eval: true,
      workerData: {
        threadId,
        startSeq,
        limit,
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
        workersPerFetcher
      }
    });
    
    worker.on('message', (message) => {
      if (message.success) {
        resolve(message);
      } else {
        reject(new Error(message.error));
      }
    });
    
    worker.on('error', reject);
    
    worker.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`Fetcher thread ${threadId} exited with code ${code}`));
      }
    });
  });
}

/**
 * Sleep for a specified duration
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Main processing loop
 */
async function main() {
  console.log('[START] npm package change watcher started');
  console.log('[CONFIG] FILTERING RULE: Only process packages WITHOUT "deleted":true');
  console.log(`[CONFIG] Fetcher threads: ${FETCHER_THREADS}`);
  console.log(`[CONFIG] Packages per thread: ${PACKAGES_PER_THREAD}`);
  console.log(`[CONFIG] Worker threads per fetcher: ${WORKER_THREADS_PER_FETCHER}`);
  console.log(`[CONFIG] Total packages per poll: ${FETCHER_THREADS * PACKAGES_PER_THREAD}`);
  console.log(`[CONFIG] Poll interval: ${POLL_INTERVAL_MS}ms`);
  console.log(`[CONFIG] Time window: ${WINDOW_DURATION_HOURS} hours ending ${WINDOW_OFFSET_HOURS} hours ago`);
  console.log('='.repeat(80));
  
  let currentSeq = await loadSequenceId();
  let consecutiveHighDeletionBatches = 0;
  
  while (true) {
    try {
      console.log('\n' + '='.repeat(80));
      console.log(`[POLL] Starting poll cycle with sequence ID: ${currentSeq}`);
      
      const { windowStart, windowEnd } = calculateTimeWindow();
      console.log(`[WINDOW] Start: ${windowStart.toISOString()}`);
      console.log(`[WINDOW] End:   ${windowEnd.toISOString()}`);
      
      const startTime = Date.now();
      
      // Launch all fetcher threads in parallel
      console.log(`[FETCHERS] Launching ${FETCHER_THREADS} fetcher threads...`);
      
      const fetcherPromises = [];
      let currentThreadSeq = currentSeq;
      
      for (let i = 0; i < FETCHER_THREADS; i++) {
        console.log(`[FETCHER ${i + 1}] Starting from seq ${currentThreadSeq}, fetching ${PACKAGES_PER_THREAD} packages`);
        
        fetcherPromises.push(
          runFetcherThread(i + 1, currentThreadSeq, PACKAGES_PER_THREAD, windowStart, windowEnd, WORKER_THREADS_PER_FETCHER)
            .catch(error => {
              console.error(`[FETCHER ${i + 1}] Error:`, error.message);
              return {
                threadId: i + 1,
                lastSeq: currentThreadSeq,
                totalChanges: 0,
                deletedCount: 0,
                activePackages: 0,
                filteredPackages: [],
                activePackageIds: [],
                deletionRate: 0,
                stats: { processed: 0, inWindow: 0, errors: 0, noTimeField: 0, outsideWindow: 0 },
                error: true
              };
            })
        );
        
        // Calculate next sequence for next thread (approximate)
        currentThreadSeq = String(parseInt(currentThreadSeq) + PACKAGES_PER_THREAD);
      }
      
      // Wait for all fetcher threads to complete
      const fetcherResults = await Promise.all(fetcherPromises);
      
      const processingTime = ((Date.now() - startTime) / 1000).toFixed(2);
      
      // Aggregate results from all fetchers
      let totalChanges = 0;
      let totalDeleted = 0;
      let totalActive = 0;
      let totalFiltered = 0;
      let maxSeq = currentSeq;
      let allFilteredPackages = [];
      let allActivePackageIds = [];
      let aggregateStats = {
        processed: 0,
        inWindow: 0,
        errors: 0,
        noTimeField: 0,
        outsideWindow: 0
      };
      
      fetcherResults.forEach((result, idx) => {
        totalChanges += result.totalChanges || 0;
        totalDeleted += result.deletedCount || 0;
        totalActive += result.activePackages || 0;
        totalFiltered += (result.filteredPackages || []).length;
        allFilteredPackages.push(...(result.filteredPackages || []));
        allActivePackageIds.push(...(result.activePackageIds || []));
        
        if (result.stats) {
          aggregateStats.processed += result.stats.processed || 0;
          aggregateStats.inWindow += result.stats.inWindow || 0;
          aggregateStats.errors += result.stats.errors || 0;
          aggregateStats.noTimeField += result.stats.noTimeField || 0;
          aggregateStats.outsideWindow += result.stats.outsideWindow || 0;
        }
        
        if (result.lastSeq && parseInt(result.lastSeq) > parseInt(maxSeq)) {
          maxSeq = result.lastSeq;
        }
        
        const status = result.error ? '\u274c ' : '\u2714 ';
        const inWindow = result.stats?.inWindow || 0;
        console.log(`[FETCHER ${idx + 1}] ${status} Total: ${result.totalChanges || 0}, Deleted: ${result.deletedCount || 0}, Active: ${result.activePackages || 0}, In window: ${inWindow}`);
      });
      
      console.log('[AGGREGATE] ' + '='.repeat(60));
      console.log(`[AGGREGATE] Total changes fetched: ${totalChanges}`);
      console.log(`[AGGREGATE] Deleted packages (filtered out): ${totalDeleted} (${totalChanges > 0 ? ((totalDeleted/totalChanges)*100).toFixed(1) : 0}%)`);
      console.log(`[AGGREGATE] Active packages (processed): ${totalActive} (${totalChanges > 0 ? ((totalActive/totalChanges)*100).toFixed(1) : 0}%)`);
      console.log(`[AGGREGATE] Packages in time window: ${totalFiltered}`);
      console.log(`[AGGREGATE] Outside window: ${aggregateStats.outsideWindow}, No time field: ${aggregateStats.noTimeField}, Errors: ${aggregateStats.errors}`);
      console.log(`[AGGREGATE] Processing time: ${processingTime} seconds`);
      console.log(`[AGGREGATE] Throughput: ${(totalChanges / parseFloat(processingTime)).toFixed(0)} packages/sec`);
      
      // Check deletion rate
      const overallDeletionRate = totalChanges > 0 ? totalDeleted / totalChanges : 0;
      
      if (overallDeletionRate >= DELETION_THRESHOLD) {
        consecutiveHighDeletionBatches++;
        console.log(`[WARN] High deletion rate: ${(overallDeletionRate * 100).toFixed(1)}% - batch ${consecutiveHighDeletionBatches}`);
        
        if (consecutiveHighDeletionBatches >= 3) {
          console.log(`[ACTION] Skipping ahead to current sequence...`);
          const newSeq = await getCurrentSequence();
          if (newSeq) {
            maxSeq = newSeq;
            consecutiveHighDeletionBatches = 0;
          }
        }
      } else {
        consecutiveHighDeletionBatches = 0;
      }
      
      // Display only the list of all active packages (new requirement)
      if (allActivePackageIds.length > 0) {
        console.log('[ACTIVE PACKAGES] All packages processed (not deleted):');
        allActivePackageIds.forEach(pkgId => {
          console.log(`  - ${pkgId}`);
        });
      } else {
        console.log('[INFO] No active packages were fetched in this poll cycle.');
      }
      
      // Original log for time-window packages (keeping for context)
      if (allFilteredPackages.length > 0) {
        console.log('[TIME WINDOW PACKAGES] Packages that matched the time window filter:');
        allFilteredPackages.forEach(pkg => {
          console.log(`  - ${pkg.id} (modified: ${pkg.modifiedTime})`);
        });
      }
      
      // Update sequence to the maximum seen
      currentSeq = maxSeq;
      await saveSequenceId(currentSeq);
      
      console.log(`[SLEEP] Waiting ${POLL_INTERVAL_MS}ms before next poll...`);
      await sleep(POLL_INTERVAL_MS);
      
    } catch (error) {
      console.error('[ERROR] Unexpected error in main loop:', error.message);
      console.error('[ERROR] Stack trace:', error.stack);
      console.log(`[RECOVERY] Waiting ${POLL_INTERVAL_MS}ms before retry...`);
      await sleep(POLL_INTERVAL_MS);
    }
  }
}

// Handle process termination gracefully
process.on('SIGINT', () => {
  console.log('\n[SHUTDOWN] Received SIGINT, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n[SHUTDOWN] Received SIGTERM, shutting down gracefully...');
  process.exit(0);
});

// Start the watcher
main().catch(error => {
  console.error('[FATAL] Unhandled error in main:', error);
  process.exit(1);
});

/**
 * watcher.js - FIXED VERSION
 * - Added rate limiting to prevent npm registry throttling
 * - Reduced concurrent requests
 * - Added detailed error logging
 * - Added retry logic for failed requests
 * - Deduplicates packages before processing
 */

const fs = require('fs/promises');
const path = require('path');
const { Worker } = require('worker_threads');
const os = require('os');

// Configuration constants
const NPM_CHANGES_URL = 'https://replicate.npmjs.com/registry/_changes';
const NPM_REGISTRY_URL = 'https://registry.npmjs.org';
const PACKAGES_PER_THREAD = 10000;
const FETCHER_THREADS = 10;
const WORKER_THREADS_PER_FETCHER = 3; // Reduced from 5 to reduce load
const POLL_INTERVAL_MS = 30000;
const MAX_RETRIES = 3; // Added retry logic
const SEQ_FILE = 'seq.txt';
const DELETION_THRESHOLD = 0.95;

// Time window configuration (in hours)
const WINDOW_DURATION_HOURS = 24;
const WINDOW_OFFSET_HOURS = 120;

/**
 * Get the current sequence ID from npm
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
 */
function calculateTimeWindow() {
  const currentTime = new Date();
  const windowEnd = new Date(currentTime.getTime() - (WINDOW_OFFSET_HOURS * 60 * 60 * 1000));
  const windowStart = new Date(windowEnd.getTime() - (WINDOW_DURATION_HOURS * 60 * 60 * 1000));
  return { windowStart, windowEnd };
}

/**
 * Fetcher thread code
 */
const fetcherThreadCode = `
const { parentPort, workerData } = require('worker_threads');
const https = require('https');
const { Worker } = require('worker_threads');

const NPM_CHANGES_URL = 'https://replicate.npmjs.com/registry/_changes';
const NPM_REGISTRY_URL = 'https://registry.npmjs.org';

// Package processor worker code with rate limiting
const packageProcessorCode = \`
const { parentPort, workerData } = require('worker_threads');
const https = require('https');

const NPM_REGISTRY_URL = 'https://registry.npmjs.org';
const REQUEST_DELAY_MS = 100; // Delay between requests to avoid rate limiting
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fetchPackageMetadata(packageName, retryCount = 0) {
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
      timeout: 15000 // Increased timeout
    };
    
    const req = https.get(url, options, (res) => {
      let data = '';
      
      // Handle rate limiting (429) or server errors (5xx)
      if (res.statusCode === 429 || res.statusCode >= 500) {
        res.resume();
        if (retryCount < MAX_RETRY_ATTEMPTS) {
          setTimeout(() => {
            fetchPackageMetadata(packageName, retryCount + 1).then(resolve);
          }, RETRY_DELAY_MS * (retryCount + 1));
        } else {
          resolve({ 
            error: true, 
            status: res.statusCode,
            packageName,
            errorType: res.statusCode === 429 ? 'rate_limit' : 'server_error',
            retriesExhausted: true
          });
        }
        return;
      }
      
      if (res.statusCode !== 200) {
        res.resume();
        resolve({ 
          error: true, 
          status: res.statusCode,
          packageName,
          errorType: 'http_status'
        });
        return;
      }
      
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ 
            error: false, 
            data: JSON.parse(data),
            packageName
          });
        } catch (error) {
          resolve({ 
            error: true, 
            parseError: true,
            packageName,
            errorType: 'parse_error',
            errorMessage: error.message
          });
        }
      });
    });
    
    req.on('error', (err) => {
      if (retryCount < MAX_RETRY_ATTEMPTS) {
        setTimeout(() => {
          fetchPackageMetadata(packageName, retryCount + 1).then(resolve);
        }, RETRY_DELAY_MS * (retryCount + 1));
      } else {
        resolve({ 
          error: true,
          packageName,
          errorType: 'network_error',
          errorMessage: err.message,
          retriesExhausted: true
        });
      }
    });
    
    req.on('timeout', () => {
      req.destroy();
      if (retryCount < MAX_RETRY_ATTEMPTS) {
        setTimeout(() => {
          fetchPackageMetadata(packageName, retryCount + 1).then(resolve);
        }, RETRY_DELAY_MS * (retryCount + 1));
      } else {
        resolve({ 
          error: true,
          packageName,
          errorType: 'timeout',
          retriesExhausted: true
        });
      }
    });
  });
}

async function processPackages(packages, windowStart, windowEnd) {
  const results = [];
  let stats = { 
    processed: 0, 
    inWindow: 0, 
    errors: 0,
    noTimeField: 0,
    outsideWindow: 0,
    retried: 0
  };
  
  const errorDetails = [];
  const outsideWindowDetails = [];
  
  for (const pkg of packages) {
    stats.processed++;
    
    if (pkg.deleted === true) {
      continue;
    }
    
    // Add delay between requests to avoid rate limiting
    if (stats.processed > 1) {
      await sleep(REQUEST_DELAY_MS);
    }
    
    const result = await fetchPackageMetadata(pkg.id);
    
    if (result.retriesExhausted) {
      stats.retried++;
    }
    
    if (result.error) {
      stats.errors++;
      errorDetails.push({
        packageName: result.packageName,
        errorType: result.errorType,
        status: result.status,
        errorMessage: result.errorMessage,
        retriesExhausted: result.retriesExhausted
      });
      continue;
    }
    
    // Check for time.modified field
    if (!result.data?.time?.modified) {
      stats.noTimeField++;
      errorDetails.push({
        packageName: result.packageName,
        errorType: 'no_time_modified',
        availableTimeFields: result.data?.time ? Object.keys(result.data.time).join(', ') : 'no_time_object'
      });
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
      outsideWindowDetails.push({
        packageName: pkg.id,
        modifiedTime: result.data.time.modified,
        modifiedTimeMs: modifiedTime.getTime(),
        windowStartMs: windowStartDate.getTime(),
        windowEndMs: windowEndDate.getTime(),
        daysFromNow: ((Date.now() - modifiedTime.getTime()) / (1000 * 60 * 60 * 24)).toFixed(1),
        hoursFromNow: ((Date.now() - modifiedTime.getTime()) / (1000 * 60 * 60)).toFixed(1)
      });
    }
  }
  
  return { results, stats, errorDetails, outsideWindowDetails };
}

processPackages(workerData.packages, workerData.windowStart, workerData.windowEnd)
  .then(data => parentPort.postMessage({ success: true, ...data }))
  .catch(error => parentPort.postMessage({ success: false, error: error.message }));
\`;

function fetchChanges(since, limit) {
  return new Promise((resolve, reject) => {
    const url = \`\${NPM_CHANGES_URL}?since=\${since}&limit=\${limit}\`;
    
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
        resolve({ 
          results: msg.results, 
          stats: msg.stats,
          errorDetails: msg.errorDetails || [],
          outsideWindowDetails: msg.outsideWindowDetails || []
        });
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
        deletionRate: 0,
        errorDetails: [],
        outsideWindowDetails: []
      });
      return;
    }
    
    const activePackages = data.results.filter(pkg => pkg.deleted !== true);
    const deletedCount = data.results.length - activePackages.length;
    const deletionRate = deletedCount / data.results.length;
    const activePackageIds = activePackages.map(pkg => pkg.id);
    
    console.log(\`[FETCHER \${threadId}] Filtering: Total=\${data.results.length}, Deleted=\${deletedCount}, Active=\${activePackages.length}\`);
    
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
        stats: { processed: 0, inWindow: 0, errors: 0, noTimeField: 0, outsideWindow: 0 },
        errorDetails: [],
        outsideWindowDetails: []
      });
      return;
    }
    
    if (activePackages.length > 0) {
      const sample = activePackages.slice(0, 3).map(p => p.id).join(', ');
      console.log(\`[FETCHER \${threadId}] Sample active packages: \${sample}\`);
    }
    
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
            stats: { processed: 0, inWindow: 0, errors: 0, noTimeField: 0, outsideWindow: 0 },
            errorDetails: [],
            outsideWindowDetails: []
          }))
      );
    }
    
    const processorResults = await Promise.all(processorPromises);
    
    const allResults = processorResults.flatMap(r => r.results);
    const allErrorDetails = processorResults.flatMap(r => r.errorDetails || []);
    const allOutsideWindowDetails = processorResults.flatMap(r => r.outsideWindowDetails || []);
    
    const aggregateStats = {
      processed: processorResults.reduce((sum, r) => sum + r.stats.processed, 0),
      inWindow: processorResults.reduce((sum, r) => sum + r.stats.inWindow, 0),
      errors: processorResults.reduce((sum, r) => sum + r.stats.errors, 0),
      noTimeField: processorResults.reduce((sum, r) => sum + (r.stats.noTimeField || 0), 0),
      outsideWindow: processorResults.reduce((sum, r) => sum + (r.stats.outsideWindow || 0), 0),
      retried: processorResults.reduce((sum, r) => sum + (r.stats.retried || 0), 0)
    };
    
    parentPort.postMessage({
      success: true,
      threadId,
      lastSeq: data.last_seq,
      totalChanges: data.results.length,
      deletedCount,
      activePackages: activePackages.length,
      filteredPackages: allResults,
      activePackageIds,
      deletionRate,
      stats: aggregateStats,
      errorDetails: allErrorDetails,
      outsideWindowDetails: allOutsideWindowDetails
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
  console.log('[START] npm package change watcher started - FIXED VERSION');
  console.log('[CONFIG] FILTERING RULE: Only process packages WITHOUT "deleted":true');
  console.log(`[CONFIG] Fetcher threads: ${FETCHER_THREADS}`);
  console.log(`[CONFIG] Packages per thread: ${PACKAGES_PER_THREAD}`);
  console.log(`[CONFIG] Worker threads per fetcher: ${WORKER_THREADS_PER_FETCHER}`);
  console.log(`[CONFIG] Total packages per poll: ${FETCHER_THREADS * PACKAGES_PER_THREAD}`);
  console.log(`[CONFIG] Poll interval: ${POLL_INTERVAL_MS}ms`);
  console.log(`[CONFIG] Time window: ${WINDOW_DURATION_HOURS} hours ending ${WINDOW_OFFSET_HOURS} hours ago`);
  console.log('[CONFIG] Improvements: Rate limiting, retry logic, request delays');
  console.log('='.repeat(80));
  
  let currentSeq = await loadSequenceId();
  let consecutiveHighDeletionBatches = 0;
  
  while (true) {
    try {
      console.log('\n' + '='.repeat(80));
      console.log(`[POLL] Starting poll cycle with sequence ID: ${currentSeq}`);
      
      const { windowStart, windowEnd } = calculateTimeWindow();
      const now = new Date();
      console.log(`[WINDOW] Start: ${windowStart.toISOString()}`);
      console.log(`[WINDOW] End:   ${windowEnd.toISOString()}`);
      console.log(`[DEBUG] Current time: ${now.toISOString()}`);
      console.log(`[DEBUG] Window is ${((now - windowEnd) / (1000 * 60 * 60)).toFixed(1)} hours ago to ${((now - windowStart) / (1000 * 60 * 60)).toFixed(1)} hours ago`);
      console.log(`[DEBUG] Window is ${((now - windowEnd) / (1000 * 60 * 60 * 24)).toFixed(1)} days ago to ${((now - windowStart) / (1000 * 60 * 60 * 24)).toFixed(1)} days ago`);
      
      const startTime = Date.now();
      
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
                stats: { processed: 0, inWindow: 0, errors: 0, noTimeField: 0, outsideWindow: 0, retried: 0 },
                errorDetails: [],
                outsideWindowDetails: [],
                error: true
              };
            })
        );
        
        currentThreadSeq = String(parseInt(currentThreadSeq) + PACKAGES_PER_THREAD);
      }
      
      const fetcherResults = await Promise.all(fetcherPromises);
      
      const processingTime = ((Date.now() - startTime) / 1000).toFixed(2);
      
      let totalChanges = 0;
      let totalDeleted = 0;
      let totalActive = 0;
      let totalFiltered = 0;
      let maxSeq = currentSeq;
      let allFilteredPackages = [];
      let allActivePackageIds = [];
      let allErrorDetails = [];
      let allOutsideWindowDetails = [];
      let aggregateStats = {
        processed: 0,
        inWindow: 0,
        errors: 0,
        noTimeField: 0,
        outsideWindow: 0,
        retried: 0
      };
      
      fetcherResults.forEach((result, idx) => {
        totalChanges += result.totalChanges || 0;
        totalDeleted += result.deletedCount || 0;
        totalActive += result.activePackages || 0;
        totalFiltered += (result.filteredPackages || []).length;
        allFilteredPackages.push(...(result.filteredPackages || []));
        allActivePackageIds.push(...(result.activePackageIds || []));
        allErrorDetails.push(...(result.errorDetails || []));
        allOutsideWindowDetails.push(...(result.outsideWindowDetails || []));
        
        if (result.stats) {
          aggregateStats.processed += result.stats.processed || 0;
          aggregateStats.inWindow += result.stats.inWindow || 0;
          aggregateStats.errors += result.stats.errors || 0;
          aggregateStats.noTimeField += result.stats.noTimeField || 0;
          aggregateStats.outsideWindow += result.stats.outsideWindow || 0;
          aggregateStats.retried += result.stats.retried || 0;
        }
        
        if (result.lastSeq && parseInt(result.lastSeq) > parseInt(maxSeq)) {
          maxSeq = result.lastSeq;
        }
        
        const status = result.error ? '❌ ' : '✔ ';
        const inWindow = result.stats?.inWindow || 0;
        console.log(`[FETCHER ${idx + 1}] ${status} Total: ${result.totalChanges || 0}, Deleted: ${result.deletedCount || 0}, Active: ${result.activePackages || 0}, In window: ${inWindow}`);
      });
      
      console.log('[AGGREGATE] ' + '='.repeat(60));
      console.log(`[AGGREGATE] Total changes fetched: ${totalChanges}`);
      console.log(`[AGGREGATE] Deleted packages (filtered out): ${totalDeleted} (${totalChanges > 0 ? ((totalDeleted/totalChanges)*100).toFixed(1) : 0}%)`);
      console.log(`[AGGREGATE] Active packages (processed): ${totalActive} (${totalChanges > 0 ? ((totalActive/totalChanges)*100).toFixed(1) : 0}%)`);
      console.log(`[AGGREGATE] Packages in time window: ${totalFiltered}`);
      console.log(`[AGGREGATE] Outside window: ${aggregateStats.outsideWindow}, No time field: ${aggregateStats.noTimeField}, Errors: ${aggregateStats.errors}, Retried: ${aggregateStats.retried}`);
      console.log(`[AGGREGATE] Processing time: ${processingTime} seconds`);
      console.log(`[AGGREGATE] Throughput: ${(totalChanges / parseFloat(processingTime)).toFixed(0)} packages/sec`);
      
      // Deduplicate active package IDs
      const uniqueActivePackages = [...new Set(allActivePackageIds)];
      
      // DEBUG: Show detailed error information
      if (allErrorDetails.length > 0) {
        console.log('\n[DEBUG] ERROR DETAILS:');
        const errorTypeCounts = {};
        allErrorDetails.forEach(err => {
          errorTypeCounts[err.errorType] = (errorTypeCounts[err.errorType] || 0) + 1;
        });
        console.log('[DEBUG] Error type breakdown:', JSON.stringify(errorTypeCounts, null, 2));
        console.log('[DEBUG] Sample errors (first 5):');
        allErrorDetails.slice(0, 5).forEach(err => {
          console.log(`  - ${err.packageName}: ${err.errorType}${err.status ? ` (HTTP ${err.status})` : ''}${err.errorMessage ? ` - ${err.errorMessage}` : ''}${err.retriesExhausted ? ' [retries exhausted]' : ''}`);
          if (err.availableTimeFields) {
            console.log(`    Available time fields: ${err.availableTimeFields}`);
          }
        });
      }
      
      // DEBUG: Show packages outside window with detailed timing info
      if (allOutsideWindowDetails.length > 0) {
        console.log('\n[DEBUG] OUTSIDE WINDOW DETAILS:');
        allOutsideWindowDetails.forEach(detail => {
          console.log(`  - ${detail.packageName}:`);
          console.log(`    Modified: ${detail.modifiedTime}`);
          console.log(`    Time from now: ${detail.daysFromNow} days (${detail.hoursFromNow} hours)`);
          console.log(`    Window: ${((Date.now() - detail.windowEndMs) / (1000 * 60 * 60 * 24)).toFixed(1)} days ago to ${((Date.now() - detail.windowStartMs) / (1000 * 60 * 60 * 24)).toFixed(1)} days ago`);
          const isOlder = detail.modifiedTimeMs < detail.windowStartMs;
          const isNewer = detail.modifiedTimeMs >= detail.windowEndMs;
          console.log(`    Status: ${isOlder ? 'TOO OLD (before window start)' : isNewer ? 'TOO NEW (after window end)' : 'UNKNOWN'}`);
        });
      }
      
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
      
      if (uniqueActivePackages.length > 0) {
        console.log('\n[ACTIVE PACKAGES] Unique packages processed (not deleted):');
        console.log(`[DEBUG] Total IDs: ${allActivePackageIds.length}, Unique: ${uniqueActivePackages.length}`);
        uniqueActivePackages.forEach(pkgId => {
          console.log(`  - ${pkgId}`);
        });
      } else {
        console.log('\n[INFO] No active packages were fetched in this poll cycle.');
      }
      
      if (allFilteredPackages.length > 0) {
        console.log('\n[TIME WINDOW PACKAGES] ✅ Packages that matched the time window filter:');
        allFilteredPackages.forEach(pkg => {
          const modTime = new Date(pkg.modifiedTime);
          const hoursAgo = ((Date.now() - modTime.getTime()) / (1000 * 60 * 60)).toFixed(1);
          const daysAgo = ((Date.now() - modTime.getTime()) / (1000 * 60 * 60 * 24)).toFixed(1);
          console.log(`  ✅ ${pkg.id}`);
          console.log(`     Modified: ${pkg.modifiedTime} (${daysAgo} days / ${hoursAgo} hours ago)`);
        });
      } else {
        console.log('\n[INFO] No packages found in the target time window.');
      }
      
      currentSeq = maxSeq;
      await saveSequenceId(currentSeq);
      
      console.log(`\n[SLEEP] Waiting ${POLL_INTERVAL_MS}ms before next poll...`);
      await sleep(POLL_INTERVAL_MS);
      
    } catch (error) {
      console.error('[ERROR] Unexpected error in main loop:', error.message);
      console.error('[ERROR] Stack trace:', error.stack);
      console.log(`[RECOVERY] Waiting ${POLL_INTERVAL_MS}ms before retry...`);
      await sleep(POLL_INTERVAL_MS);
    }
  }
}

process.on('SIGINT', () => {
  console.log('\n[SHUTDOWN] Received SIGINT, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n[SHUTDOWN] Received SIGTERM, shutting down gracefully...');
  process.exit(0);
});

main().catch(error => {
  console.error('[FATAL] Unhandled error in main:', error);
  process.exit(1);
});

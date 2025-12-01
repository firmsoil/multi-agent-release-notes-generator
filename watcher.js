/**
 * Process changes in batches with concurrency control
 */
async function processChangesInBatches(results, stats) {
    const chunks = [];
    for (let i = 0; i < results.length; i += MAX_CONCURRENT_REQUESTS) {
        chunks.push(results.slice(i, i + MAX_CONCURRENT_REQUESTS));
    }
    
    let processedCount = 0;
    for (const chunk of chunks) {
        const promises = chunk.map(async (change) => {
            const result = await getPackageVersion(change.id);
            
            if (result.status === 200) {
                stats.published++;
                // Display package with version and publish time
                const displayVersion = change.version || result.version;
                const publishTime = change.publishTime ? ` (published: ${change.publishTime})` : '';
                console.log(`[${change.seq}] 📦 Package: **${change.id}** @ v${displayVersion}${publishTime}`);
                return { type: 'published', change, result };
            } else if (result.status === 404) {
                stats.deleted++;
                return { type: 'deleted', change, result };
            } else {
                stats.errors++;
                console.log(`[${change.seq}] ⚠️  Package: **${change.id}** (${result.version})`);
                return { type: 'error', change, result };
            }
        });
        
        await Promise.all(promises);
        processedCount += chunk.length;
        
        // Show progress
        if (processedCount % 50 === 0 || processedCount === results.length) {
            console.log(`   ... processed ${processedCount}/${results.length} changes`);
        }
    }
}// watcher.js

const fetch = require('node-fetch').default; 

const NPM_CHANGES_URL = 'https://replicate.npmjs.com/registry/_changes';
const NPM_REGISTRY_URL = 'https://registry.npmjs.org';
const BATCH_LIMIT = 100; // Reduced to 100 for faster processing
const HOURS_TO_LOOK_BACK = 120; // Start 120 hours ago
const TIME_WINDOW_MINUTES = 5; // 5 minute window
const MAX_CONCURRENT_REQUESTS = 10; // Limit concurrent API calls
const POLL_INTERVAL_MS = 5 * 60 * 1000; // Poll every 5 minutes for new changes

/**
 * Fetches package details from the npm registry to get version info
 */
async function getPackageVersion(packageName) {
    try {
        const response = await fetch(`${NPM_REGISTRY_URL}/${packageName}/latest`);
        if (response.status === 404) {
            return { version: 'deleted/unpublished', status: 404 };
        }
        if (!response.ok) {
            return { version: `error-${response.status}`, status: response.status };
        }
        const data = await response.json();
        return { version: data.version || 'no-version-field', status: 200 };
    } catch (error) {
        return { version: 'fetch-error', status: 0 };
    }
}

/**
 * Polls the npm changes feed for updates within a rolling time window
 */
async function pollChanges(sinceSeq, stats) {
    try {
        // Calculate the current rolling time window
        const now = Date.now();
        const windowStart = now - (HOURS_TO_LOOK_BACK * 60 * 60 * 1000);
        const windowEnd = windowStart + (TIME_WINDOW_MINUTES * 60 * 1000);
        
        const url = `${NPM_CHANGES_URL}?since=${sinceSeq}&limit=${BATCH_LIMIT}`;
        
        const response = await fetch(url);
        if (!response.ok) {
            console.error(`❌ Failed to fetch changes: ${response.status} ${response.statusText}`);
            return sinceSeq; // Return current sequence on error
        }
        
        const data = await response.json();
        const results = data.results || [];
        const newLastSeq = data.last_seq;
        
        if (results.length === 0) {
            return newLastSeq;
        }
        
        // Filter results to only include packages published within our rolling time window
        const filteredResults = [];
        let debugCount = 0;
        const maxDebugSamples = 3; // Show details for first 3 packages
        
        for (const change of results) {
            // Fetch package info to check publish time
            try {
                const pkgResponse = await fetch(`${NPM_REGISTRY_URL}/${change.id}`);
                if (pkgResponse.ok) {
                    const pkgData = await pkgResponse.json();
                    
                    // Get the latest version to check its publish time
                    const distTags = pkgData['dist-tags'];
                    const latestVersion = distTags && distTags.latest;
                    
                    // DEBUG: Show sample package details
                    if (debugCount < maxDebugSamples) {
                        console.log(`\n  🔍 DEBUG Sample ${debugCount + 1}: ${change.id}`);
                        console.log(`     Latest version: ${latestVersion || 'N/A'}`);
                        if (latestVersion && pkgData.time && pkgData.time[latestVersion]) {
                            const publishTime = new Date(pkgData.time[latestVersion]).toISOString();
                            console.log(`     Published at: ${publishTime}`);
                            console.log(`     Window start: ${new Date(windowStart).toISOString()}`);
                            console.log(`     Window end:   ${new Date(windowEnd).toISOString()}`);
                            console.log(`     In window? ${new Date(pkgData.time[latestVersion]).getTime() >= windowStart && new Date(pkgData.time[latestVersion]).getTime() <= windowEnd}`);
                        } else {
                            console.log(`     No publish time available`);
                        }
                        debugCount++;
                    }
                    
                    if (latestVersion && pkgData.time && pkgData.time[latestVersion]) {
                        const publishTime = new Date(pkgData.time[latestVersion]).getTime();
                        
                        // Check if the latest version was published within our rolling window
                        if (publishTime >= windowStart && publishTime <= windowEnd) {
                            // Add version info to the change object
                            change.version = latestVersion;
                            change.publishTime = new Date(publishTime).toISOString();
                            filteredResults.push(change);
                        }
                    }
                }
            } catch (err) {
                // Skip packages we can't check
                continue;
            }
        }
        
        console.log(`📦 Received ${results.length} changes, ${filteredResults.length} within rolling time window (${new Date(windowStart).toISOString()} to ${new Date(windowEnd).toISOString()})`);
        
        if (filteredResults.length > 0) {
            // Process changes with concurrency control
            await processChangesInBatches(filteredResults, stats);
            console.log(`📊 Running Stats: ${stats.published} published | ${stats.deleted} deleted | ${stats.errors} errors`);
        }
        
        return newLastSeq;
        
    } catch (error) {
        console.error('❌ Error during polling:', error.message);
        return sinceSeq; // Return current sequence on error
    }
}

/**
 * Calculates the initial starting sequence
 */
async function calculateStartSequence() {
    try {
        console.log(`1. Fetching current sequence from ${NPM_CHANGES_URL}...`);
        
        const response = await fetch(NPM_CHANGES_URL);
        const data = await response.json();
        
        let currentSeqString = String(data.last_seq);
        
        if (!currentSeqString || currentSeqString === 'undefined' || currentSeqString === 'null') {
            throw new Error(`Invalid or missing 'last_seq' in API response: ${data.last_seq}`);
        }
        
        const currentSeqNumber = parseInt(currentSeqString.split('-')[0], 10);
        
        if (isNaN(currentSeqNumber)) {
            throw new Error(`Could not parse sequence number component: ${currentSeqString}`);
        }
        
        console.log(`2. Current Seq: ${currentSeqNumber}`);
        console.log(`3. Monitoring window: ${HOURS_TO_LOOK_BACK} hours ago + ${TIME_WINDOW_MINUTES} minutes (rolling)`);
        console.log("--------------------------------------------------");
        
        // Start from current sequence and look forward
        return currentSeqNumber;
        
    } catch (error) {
        console.error('🚨 Failed to calculate start sequence:', error.message);
        throw error;
    }
}

/**
 * Main watcher function that continuously monitors the rolling time window
 */
async function startWatcher() {
    try {
        // Get initial sequence to start monitoring from
        const startSeq = await calculateStartSequence();
        
        console.log(`4. Starting continuous monitoring (poll interval: ${POLL_INTERVAL_MS / 1000}s)...\n`);
        
        let currentSeq = startSeq;
        
        // Continuous polling loop
        while (true) {
            console.log(`\n🔄 Polling for new changes (current seq: ${currentSeq})...`);
            
            const newSeq = await pollChanges(currentSeq, stats);
            
            // Update sequence
            if (newSeq !== currentSeq) {
                currentSeq = newSeq;
            }
            
            // Wait before next poll
            console.log(`⏳ Waiting ${POLL_INTERVAL_MS / 1000} seconds until next poll...`);
            await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
        }
        
    } catch (error) {
        console.error('🚨 Fatal error in watcher:', error.message);
        process.exit(1);
    }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('\n\n👋 Stopping the watcher...');
    console.log('\n' + '='.repeat(50));
    console.log('📊 FINAL STATISTICS');
    console.log('='.repeat(50));
    console.log(`Monitoring window: ${HOURS_TO_LOOK_BACK} hours ago + ${TIME_WINDOW_MINUTES} minutes (rolling)`);
    console.log(`Published packages found: ${stats.published}`);
    console.log(`Deleted packages filtered: ${stats.deleted}`);
    console.log(`Errors encountered: ${stats.errors}`);
    console.log('='.repeat(50));
    process.exit(0);
});

// Make stats accessible to SIGINT handler
let stats = { published: 0, deleted: 0, errors: 0 };

// Start the watcher
startWatcher();

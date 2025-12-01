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
                console.log(`[${change.seq}] 📦 Package: **${change.id}** @ v${result.version}`);
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
const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const BATCH_LIMIT = 100; // Reduced to 100 for faster processing
const MINUTES_TO_LOOK_BACK = 1; // Set to 1 minute for testing
const MAX_CONCURRENT_REQUESTS = 10; // Limit concurrent API calls

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
 * Polls the npm changes feed for updates
 */
async function pollChanges(sinceSeq, stats) {
    try {
        const url = `${NPM_CHANGES_URL}?since=${sinceSeq}&limit=${BATCH_LIMIT}`;
        console.log(`\n🔄 Polling changes since sequence ${sinceSeq}...`);
        
        const response = await fetch(url);
        if (!response.ok) {
            console.error(`❌ Failed to fetch changes: ${response.status} ${response.statusText}`);
            return sinceSeq; // Return current sequence on error
        }
        
        const data = await response.json();
        const results = data.results || [];
        const newLastSeq = data.last_seq;
        
        console.log(`📦 Received ${results.length} changes (new last_seq: ${newLastSeq})`);
        
        if (results.length === 0) {
            console.log('✅ No new changes detected');
            return newLastSeq;
        }
        
        // Process changes with concurrency control
        await processChangesInBatches(results, stats);
        
        console.log(`📊 Batch Stats: ${stats.published} published | ${stats.deleted} deleted | ${stats.errors} errors`);
        
        return newLastSeq;
        
    } catch (error) {
        console.error('❌ Error during polling:', error.message);
        return sinceSeq; // Return current sequence on error
    }
}

/**
 * Calculates the starting sequence based on minutes to look back
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
        
        // For initial testing, start from current sequence
        // In production, you might want to look back further
        const estimatedChangesPerMinute = 1000; // More realistic estimate
        const offset = estimatedChangesPerMinute * MINUTES_TO_LOOK_BACK;
        const startSeqNumber = Math.max(0, currentSeqNumber - offset);
        
        console.log(`2. Current Seq: ${currentSeqNumber}`);
        console.log(`3. Starting from Seq: ${startSeqNumber} (${MINUTES_TO_LOOK_BACK} mins ago, offset: ${offset})`);
        console.log("--------------------------------------------------");
        
        return startSeqNumber;
        
    } catch (error) {
        console.error('🚨 Failed to calculate start sequence:', error.message);
        throw error;
    }
}

/**
 * Main watcher function that polls continuously
 */
async function startWatcher() {
    let currentSeq;
    const stats = { published: 0, deleted: 0, errors: 0 };
    
    try {
        // Calculate starting sequence
        currentSeq = await calculateStartSequence();
        
        console.log(`4. Starting polling loop (interval: ${POLL_INTERVAL_MS / 1000}s)...\n`);
        
        // Continuous polling loop
        while (true) {
            currentSeq = await pollChanges(currentSeq, stats);
            
            // Wait for the polling interval
            console.log(`\n⏳ Waiting ${POLL_INTERVAL_MS / 1000} seconds until next poll...`);
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
    console.log('📊 Final statistics will be shown on next poll cycle');
    process.exit(0);
});

// Start the watcher
startWatcher();

const { execSync, spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const yaml = require('js-yaml');

const url = process.argv[2];

if (!url) {
  console.error('Usage: node index.js <url>');
  console.error('Example: node index.js https://example.com/video-page');
  process.exit(1);
}

// Load sites.yaml and find matching site rule
function loadMatchedSite(inputUrl) {
  const sitesPath = path.join(__dirname, 'sites.yaml');
  if (!fs.existsSync(sitesPath)) return null;
  const config = yaml.load(fs.readFileSync(sitesPath, 'utf-8'));
  if (!config?.sites) return null;
  return config.sites.find((site) => inputUrl.startsWith(site.prefix)) || null;
}

const matchedSite = loadMatchedSite(url);
if (matchedSite) {
  console.log(`Matched site rule: prefix="${matchedSite.prefix}" targetRegEx="${matchedSite.targetRegEx}"`);
} else {
  console.log('No matching site rule found. All m3u8 URLs will generate yt-dlp commands.');
}

const detectedUrls = new Set();
const ytDlpDir = path.join(__dirname, 'yt-dlp');

function findChrome() {
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  try {
    return execSync('which google-chrome || which chromium', { encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

function parseNetLog(logPath) {
  let data = fs.readFileSync(logPath, 'utf-8');

  // NetLog file may be incomplete (not closed properly) — fix trailing JSON
  data = data.trimEnd();
  if (data.endsWith(',')) {
    data = data.slice(0, -1);
  }
  if (!data.endsWith(']}')) {
    data += ']}';
  }

  const netlog = JSON.parse(data);
  const constants = netlog.constants || {};
  const events = netlog.events || [];

  // Build reverse lookup: event type number -> name
  const eventTypeById = {};
  if (constants.logEventTypes) {
    for (const [name, id] of Object.entries(constants.logEventTypes)) {
      eventTypeById[id] = name;
    }
  }

  // Group events by source.id
  const sourceEvents = {};
  for (const evt of events) {
    const srcId = evt.source?.id;
    if (srcId == null) continue;
    if (!sourceEvents[srcId]) sourceEvents[srcId] = [];
    sourceEvents[srcId].push(evt);
  }

  // Find m3u8 requests and their headers
  const results = [];

  for (const [, evts] of Object.entries(sourceEvents)) {
    let requestUrl = null;
    let headers = null;

    for (const evt of evts) {
      const typeName = eventTypeById[evt.type] || '';
      const params = evt.params || {};

      // Find the URL
      if (typeName === 'URL_REQUEST_START_JOB' && params.url) {
        requestUrl = params.url;
      }

      // Find request headers (HTTP/1.1, HTTP/2, QUIC)
      if (
        typeName === 'HTTP_TRANSACTION_SEND_REQUEST_HEADERS' ||
        typeName === 'HTTP_TRANSACTION_HTTP2_SEND_REQUEST_HEADERS' ||
        typeName === 'HTTP_TRANSACTION_QUIC_SEND_REQUEST_HEADERS'
      ) {
        if (params.headers) {
          headers = params.headers;
        }
      }
    }

    if (requestUrl && requestUrl.includes('.m3u8') && !detectedUrls.has(requestUrl)) {
      detectedUrls.add(requestUrl);
      results.push({ url: requestUrl, headers });
    }
  }

  return results;
}

function parseHeaders(headers) {
  const parsed = {};
  if (!headers) return parsed;
  for (const line of headers) {
    // Skip the request line (e.g. "GET /path HTTP/1.1")
    if (/^[A-Z]+ .+ HTTP\//.test(line)) continue;
    // Skip HTTP/2 pseudo-headers (e.g. ":path", ":method", ":authority", ":scheme")
    if (line.startsWith(':')) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const name = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    parsed[name.toLowerCase()] = { name, value };
  }
  return parsed;
}

function buildYtDlpCommand(m3u8Url, headers, outputName) {
  const parsed = parseHeaders(headers);
  const parts = ['yt-dlp'];

  const concurrentFragments = matchedSite?.concurrentFragments || 1;
  parts.push(`-N ${concurrentFragments}`);

  if (outputName) {
    parts.push(`-o '${outputName}.%(ext)s'`);
  }

  // Headers that yt-dlp supports as dedicated flags
  if (parsed['referer']) {
    parts.push(`--referer '${parsed['referer'].value}'`);
  }
  if (parsed['user-agent']) {
    parts.push(`--user-agent '${parsed['user-agent'].value}'`);
  }

  // Add other meaningful headers via --add-header (skip browser-internal ones)
  const includeCookie = matchedSite?.includeCookie === true;
  const skipHeaders = new Set([
    'host', 'referer', 'user-agent', 'connection', 'accept-encoding',
    'accept-language', 'accept', 'sec-fetch-dest', 'sec-fetch-mode',
    'sec-fetch-site', 'sec-fetch-storage-access',
    'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform',
    'dnt', 'upgrade-insecure-requests', 'cache-control', 'pragma',
    'priority',
  ]);
  if (!includeCookie) {
    skipHeaders.add('cookie');
  }

  for (const [key, { name, value }] of Object.entries(parsed)) {
    if (skipHeaders.has(key)) continue;
    parts.push(`--add-header '${name}: ${value}'`);
  }

  parts.push(`'${m3u8Url}'`);
  return parts.join(' \\\n  ');
}

function shouldShowYtDlp(m3u8Url) {
  if (!matchedSite) return true;
  return new RegExp(matchedSite.targetRegEx).test(m3u8Url);
}

function generateBaseName() {
  const now = new Date();
  const ts = now.getFullYear()
    + '_' + String(now.getMonth() + 1).padStart(2, '0')
    + '_' + String(now.getDate()).padStart(2, '0')
    + 'T' + String(now.getHours()).padStart(2, '0')
    + '_' + String(now.getMinutes()).padStart(2, '0')
    + '_' + String(now.getSeconds()).padStart(2, '0');
  let baseName = ts;
  let counter = 2;
  while (fs.existsSync(path.join(ytDlpDir, `${baseName}.sh`))) {
    baseName = `${ts}-${counter}`;
    counter++;
  }
  return baseName;
}

function writeScript(baseName, cmd) {
  if (!fs.existsSync(ytDlpDir)) {
    fs.mkdirSync(ytDlpDir, { recursive: true });
  }
  const filePath = path.join(ytDlpDir, `${baseName}.sh`);
  const content = `#!/bin/bash\n# Source URL: ${url}\n\n${cmd}\n`;
  fs.writeFileSync(filePath, content);
  fs.chmodSync(filePath, 0o755);
  console.log(`Script saved: ${filePath}`);
}

function printResults(results) {
  for (const { url: m3u8Url, headers } of results) {
    const showCmd = shouldShowYtDlp(m3u8Url);

    console.log(`\n${'='.repeat(80)}`);
    console.log(`[m3u8] #${detectedUrls.size}: ${m3u8Url}`);
    if (!showCmd && matchedSite) {
      console.log(`  (skipped: does not match targetRegEx)`);
    }
    console.log('='.repeat(80));

    if (headers && headers.length > 0) {
      console.log('Request Headers:');
      for (const line of headers) {
        console.log(`  ${line}`);
      }
    } else {
      console.log('Request Headers: (not captured)');
    }

    if (showCmd) {
      const baseName = generateBaseName();
      const cmd = buildYtDlpCommand(m3u8Url, headers, baseName);
      console.log('\nyt-dlp command:');
      console.log(cmd);
      writeScript(baseName, cmd);
    }
  }
}

function scanNetLog(logPath) {
  try {
    const results = parseNetLog(logPath);
    if (results.length > 0) {
      printResults(results);
    }
  } catch {
    // File may not exist yet, be incomplete, or unparseable mid-write
  }
}

async function main() {
  const chromePath = findChrome();
  if (!chromePath) {
    console.error('Error: Could not find Chrome or Chromium. Please install Google Chrome.');
    process.exit(1);
  }

  const userDataDir = path.join(os.tmpdir(), 'extract-video-url-profile');
  const netLogPath = path.join(os.tmpdir(), 'extract-video-url-netlog.json');

  // Clean up old netlog
  try { fs.unlinkSync(netLogPath); } catch {}

  console.log(`NetLog path: ${netLogPath}`);
  console.log(`Launching Chrome and navigating to: ${url}`);
  console.log('Monitoring network requests for m3u8 URLs...');
  console.log('Play the video manually. Close the browser window when done.\n');

  const chromeProcess = spawn(chromePath, [
    `--user-data-dir=${userDataDir}`,
    `--log-net-log=${netLogPath}`,
    '--net-log-capture-mode=Everything',
    '--no-first-run',
    '--no-default-browser-check',
    url,
  ], {
    stdio: 'ignore',
    detached: false,
  });

  // Poll the netlog file periodically
  const pollInterval = setInterval(() => {
    scanNetLog(netLogPath);
  }, 3000);

  // Wait for Chrome to exit
  await new Promise((resolve) => {
    chromeProcess.on('close', resolve);
  });

  clearInterval(pollInterval);

  // Final scan
  scanNetLog(netLogPath);

  // Clean up netlog file
  try { fs.unlinkSync(netLogPath); } catch {}

  console.log('\n' + '='.repeat(80));
  if (detectedUrls.size === 0) {
    console.log('No m3u8 URLs were detected.');
  } else {
    console.log(`Done. Detected ${detectedUrls.size} unique m3u8 URL(s).`);
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});

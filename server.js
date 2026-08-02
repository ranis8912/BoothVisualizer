/**
 * GES Booth Visualizer — v2
 * Run:  node server.js
 * Open: http://localhost:3001
 *
 * Azure App Service: set PORT env var; app binds to all interfaces automatically.
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

// Load .env file if present
try {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n').forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eq = trimmed.indexOf('=');
    if (eq > 0) process.env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  });
} catch(e) {}

const PORT = process.env.PORT || 3000;

// ─── HTTPS helpers ─────────────────────────────────────────────────────────────

function httpsPost(hostname, urlPath, headers, body, redirects) {
  redirects = redirects || 0;
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req  = https.request({
      hostname, path: urlPath, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers }
    }, res => {
      if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) && res.headers.location && redirects < 5) {
        const loc = new URL(res.headers.location, 'https://' + hostname);
        res.resume();
        console.log('  Redirect', res.statusCode, '->', loc.href);
        httpsPost(loc.hostname, loc.pathname + loc.search, headers, body, redirects + 1).then(resolve).catch(reject);
        return;
      }
      const c = [];
      res.on('data', d => c.push(d));
      res.on('end', () => {
        const raw = Buffer.concat(c).toString();
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch(e) { reject(new Error('API returned non-JSON (status ' + res.statusCode + '): ' + raw.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function httpsGet(hostname, urlPath, headers, redirects) {
  redirects = redirects || 0;
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, path: urlPath, method: 'GET', headers
    }, res => {
      if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) && res.headers.location && redirects < 5) {
        const loc = new URL(res.headers.location, 'https://' + hostname);
        res.resume();
        console.log('  Redirect', res.statusCode, '->', loc.href);
        httpsGet(loc.hostname, loc.pathname + loc.search, headers, redirects + 1).then(resolve).catch(reject);
        return;
      }
      const c = [];
      res.on('data', d => c.push(d));
      res.on('end', () => {
        const raw = Buffer.concat(c).toString();
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch(e) { reject(new Error('API returned non-JSON (status ' + res.statusCode + '): ' + raw.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function stabilityPost(apiKey, prompt, negativePrompt) {
  return new Promise((resolve, reject) => {
    const boundary = 'GESBoundary' + Date.now().toString(16);
    const parts = [
      '--' + boundary + '\r\nContent-Disposition: form-data; name="prompt"\r\n\r\n' + prompt + '\r\n',
      '--' + boundary + '\r\nContent-Disposition: form-data; name="aspect_ratio"\r\n\r\n16:9\r\n',
      '--' + boundary + '\r\nContent-Disposition: form-data; name="output_format"\r\n\r\njpeg\r\n',
    ];
    if (negativePrompt) parts.push(
      '--' + boundary + '\r\nContent-Disposition: form-data; name="negative_prompt"\r\n\r\n' + negativePrompt + '\r\n'
    );
    parts.push('--' + boundary + '--\r\n');
    const body = Buffer.from(parts.join(''));
    const req = https.request({
      hostname: 'api.stability.ai',
      path: '/v2beta/stable-image/generate/ultra',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Accept': 'application/json',
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': body.length
      }
    }, res => {
      const c = [];
      res.on('data', d => c.push(d));
      res.on('end', () => {
        const raw = Buffer.concat(c).toString();
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch(e) { reject(new Error('Stability AI returned non-JSON (status ' + res.statusCode + '): ' + raw.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function httpsGetBinary(imageUrl) {
  return new Promise((resolve, reject) => {
    const u   = new URL(imageUrl);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET'
    }, res => {
      const c = [];
      res.on('data', d => c.push(d));
      res.on('end', () => resolve({ data: Buffer.concat(c), contentType: res.headers['content-type'] || 'image/png' }));
    });
    req.on('error', reject);
    req.end();
  });
}

function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}

// ─── HTML SPA ──────────────────────────────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>GES Booth Visualizer</title>
<style>
:root {
  --primary:    #114261;
  --secondary:  #1E4C69;
  --accent:     #295673;
  --highlight:  #A8B7C3;
  --light-text: #F3F4F3;
  --bg:         #f0f4f8;
  --surface:    #ffffff;
  --border:     #dce5ee;
  --text-dark:  #1a2d3f;
  --text-mid:   #6b7f8e;
  --r: 8px;
  --sh:    0 2px 12px rgba(17,66,97,.08);
  --sh-md: 0 4px 20px rgba(17,66,97,.14);
}
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: system-ui,-apple-system,'Segoe UI',sans-serif; background: var(--bg); color: var(--text-dark); min-height: 100vh; display: flex; flex-direction: column; }

/* TAGLINE BAR */
.tagline-bar { background: var(--secondary); padding: 4px 20px; text-align: center; font-size: 11px; color: var(--highlight); letter-spacing: .4px; flex-shrink: 0; }
.tagline-bar strong { color: var(--light-text); font-weight: 700; }

/* NAV */
nav { background: var(--primary); height: 52px; padding: 0 20px; display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; }
.nav-left  { display: flex; align-items: center; gap: 10px; }
.nav-logo  { height: 32px; width: auto; object-fit: contain; }
.nav-divider { width: 1px; height: 20px; background: rgba(255,255,255,.2); flex-shrink: 0; }
.nav-title { font-size: 15px; font-weight: 600; color: var(--light-text); white-space: nowrap; }
.nav-badge { background: rgba(168,183,195,.12); border: 1px solid rgba(168,183,195,.35); color: var(--highlight); font-size: 10px; font-weight: 700; padding: 2px 8px; border-radius: 20px; text-transform: uppercase; letter-spacing: .5px; white-space: nowrap; }
.nav-right { display: flex; align-items: center; gap: 8px; }
.settings-btn { background: none; border: 1px solid rgba(255,255,255,.22); color: var(--highlight); padding: 5px 12px; border-radius: 6px; font-size: 11px; font-weight: 600; cursor: pointer; transition: all .2s; }
.settings-btn:hover { border-color: rgba(255,255,255,.6); color: var(--light-text); }

/* SETTINGS DRAWER */
#settings-drawer { background: var(--secondary); border-bottom: 1px solid rgba(0,0,0,.15); padding: 14px 20px; display: flex; align-items: flex-end; gap: 16px; flex-wrap: wrap; }
.sf { display: flex; flex-direction: column; gap: 4px; min-width: 220px; flex: 1; }
.sf label { font-size: 10px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; color: var(--highlight); }
.sf input { padding: 7px 10px; background: rgba(0,0,0,.2); border: 1.5px solid rgba(255,255,255,.15); border-radius: 6px; color: var(--light-text); font-size: 12px; font-family: monospace; outline: none; transition: border-color .2s; width: 100%; }
.sf input:focus { border-color: var(--highlight); }
.sf-hint { font-size: 10px; color: rgba(168,183,195,.65); margin-top: 2px; }
.sf-save { padding: 8px 18px; background: var(--accent); color: var(--light-text); border: none; border-radius: 6px; font-size: 11px; font-weight: 700; cursor: pointer; align-self: flex-end; white-space: nowrap; flex-shrink: 0; transition: background .2s; }
.sf-save:hover { background: var(--primary); }

/* APP BODY */
.app-body { display: grid; grid-template-columns: 310px 1fr; flex: 1; min-height: 0; overflow: hidden; }

/* LEFT PANEL */
.left-panel { background: var(--surface); border-right: 1px solid var(--border); display: flex; flex-direction: column; overflow-y: auto; }
.form-section { padding: 12px 14px; border-bottom: 1px solid var(--border); }
.section-label { font-size: 9px; font-weight: 800; letter-spacing: 1.5px; text-transform: uppercase; color: var(--text-mid); margin-bottom: 8px; }
.field { display: flex; flex-direction: column; gap: 3px; margin-bottom: 8px; }
.field:last-child { margin-bottom: 0; }
.field label { font-size: 11px; font-weight: 600; color: var(--text-dark); }
.field input, .field select, .field textarea { width: 100%; padding: 7px 9px; border: 1.5px solid var(--border); border-radius: 6px; font-size: 12px; font-family: inherit; color: var(--text-dark); background: white; outline: none; transition: border-color .2s; }
.field input:focus, .field select:focus, .field textarea:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(41,86,115,.08); }
.field textarea { resize: vertical; line-height: 1.55; min-height: 80px; }
.two-col-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; margin-bottom: 8px; }
.two-col-fields .field { margin-bottom: 0; }

/* CHIPS */
.chip-group { display: flex; flex-wrap: wrap; gap: 5px; }
.chip { padding: 4px 10px; border: 1.5px solid var(--border); border-radius: 20px; font-size: 11px; font-weight: 500; color: var(--text-mid); cursor: pointer; transition: all .15s; background: white; user-select: none; }
.chip:hover { border-color: var(--accent); color: var(--accent); }
.chip.active { background: var(--secondary); border-color: var(--secondary); color: var(--light-text); }

/* UPLOAD ZONES */
.upload-zone { border: 2px dashed var(--border); border-radius: var(--r); padding: 12px 10px; text-align: center; cursor: pointer; transition: all .2s; background: #fafbfd; position: relative; }
.upload-zone input[type=file] { position: absolute; inset: 0; opacity: 0; cursor: pointer; width: 100%; height: 100%; }
.upload-zone:hover, .upload-zone.dragover { border-color: var(--accent); background: #f0f5fa; }
.upload-icon { font-size: 22px; margin-bottom: 4px; }
.upload-title { font-size: 11px; font-weight: 600; color: var(--text-dark); margin-bottom: 2px; }
.upload-hint  { font-size: 10px; color: var(--text-mid); }
.preview-wrap { position: relative; border-radius: var(--r); overflow: hidden; border: 1px solid var(--border); }
.preview-wrap img { width: 100%; max-height: 110px; object-fit: cover; display: block; }
.preview-remove { position: absolute; top: 4px; right: 4px; background: rgba(17,66,97,.75); color: white; border: none; border-radius: 50%; width: 20px; height: 20px; font-size: 11px; cursor: pointer; display: flex; align-items: center; justify-content: center; line-height: 1; }
#pdf-preview { display: flex; align-items: center; gap: 7px; background: #f0f5fa; border: 1px solid var(--border); border-radius: 6px; padding: 7px 10px; }
.pdf-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--text-dark); }
.pdf-remove { background: none; border: none; cursor: pointer; color: var(--text-mid); font-size: 14px; flex-shrink: 0; line-height: 1; padding: 0; }
.pdf-remove:hover { color: var(--primary); }

/* GENERATE BUTTON */
.gen-btn { margin: 10px 14px 14px; padding: 11px; background: var(--secondary); color: var(--light-text); border: none; border-radius: var(--r); font-size: 13px; font-weight: 700; cursor: pointer; transition: all .2s; letter-spacing: .2px; }
.gen-btn:hover:not(:disabled) { background: var(--primary); transform: translateY(-1px); box-shadow: 0 4px 18px rgba(17,66,97,.25); }
.gen-btn:disabled { background: #b0bec5; cursor: not-allowed; transform: none; box-shadow: none; }

/* RIGHT PANEL */
.right-panel { display: flex; flex-direction: column; overflow: hidden; }
#results-area { flex: 1; overflow-y: auto; display: flex; flex-direction: column; }

/* EMPTY STATE */
#empty-state { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 40px 24px; text-align: center; }
.empty-icon  { font-size: 48px; margin-bottom: 16px; }
.empty-title { font-size: 22px; font-weight: 800; color: var(--primary); margin-bottom: 8px; }
.empty-desc  { color: var(--text-mid); font-size: 12px; line-height: 1.75; max-width: 320px; margin-bottom: 14px; }
.empty-hint  { font-size: 11px; color: var(--accent); background: rgba(41,86,115,.07); border: 1px solid rgba(41,86,115,.18); padding: 6px 14px; border-radius: 20px; margin-bottom: 22px; }
.empty-features { display: flex; gap: 10px; flex-wrap: wrap; justify-content: center; }
.empty-feature  { background: var(--surface); border-radius: 10px; padding: 12px 14px; box-shadow: var(--sh); font-size: 11px; color: var(--text-mid); text-align: center; min-width: 80px; }
.ef-icon { font-size: 22px; margin-bottom: 4px; }

/* RESULTS PANEL */
#results-panel { flex-direction: column; }
.results-header { background: var(--surface); border-bottom: 1px solid var(--border); padding: 12px 18px; display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-shrink: 0; }
.results-title { font-size: 14px; font-weight: 700; }
.results-sub   { font-size: 11px; color: var(--text-mid); margin-top: 1px; }
.results-actions { display: flex; gap: 7px; flex-shrink: 0; }
.btn-outline  { padding: 6px 12px; border: 1.5px solid var(--border); border-radius: 6px; background: white; font-size: 11px; font-weight: 600; color: var(--text-dark); cursor: pointer; transition: all .15s; white-space: nowrap; }
.btn-outline:hover { border-color: var(--accent); color: var(--accent); }
.btn-primary  { padding: 6px 12px; border: none; border-radius: 6px; background: var(--secondary); color: var(--light-text); font-size: 11px; font-weight: 700; cursor: pointer; transition: background .2s; white-space: nowrap; }
.btn-primary:hover { background: var(--primary); }
.results-body { padding: 14px; display: flex; flex-direction: column; gap: 13px; }

/* RENDER CARD */
.render-card        { background: var(--surface); border-radius: 10px; box-shadow: var(--sh); overflow: hidden; }
.render-card-header { background: var(--primary); padding: 10px 16px; display: flex; align-items: center; justify-content: space-between; }
.render-card-header > span { font-size: 11px; font-weight: 700; letter-spacing: .5px; color: var(--light-text); text-transform: uppercase; }
.flux-badge { font-size: 10px; color: var(--highlight); font-weight: 600; display: flex; align-items: center; gap: 5px; }
.flux-badge::before { content: ''; width: 6px; height: 6px; background: #5ab0ff; border-radius: 50%; animation: blink 2s infinite; }
@keyframes blink { 0%,100%{opacity:1} 50%{opacity:.3} }
.render-card-body { padding: 14px 16px; }
.rerender-bar { display: flex; align-items: center; justify-content: space-between; gap: 10px; background: #fef9c3; border: 1px solid #fde68a; border-radius: 6px; padding: 7px 12px; margin-bottom: 10px; font-size: 11px; color: #713f12; }
.btn-sm { padding: 4px 10px; border: 1px solid #f59e0b; border-radius: 5px; background: white; font-size: 10px; font-weight: 600; color: #92400e; cursor: pointer; white-space: nowrap; }
.render-idle-row { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.btn-render { padding: 9px 18px; background: var(--secondary); color: var(--light-text); border: none; border-radius: 6px; font-size: 12px; font-weight: 700; cursor: pointer; transition: background .2s; }
.btn-render:hover:not(:disabled) { background: var(--primary); }
.btn-render:disabled { background: #b0bec5; cursor: not-allowed; }
.render-hint { font-size: 11px; color: var(--text-mid); }
.render-progress { display: flex; align-items: center; gap: 8px; padding: 6px 0; font-size: 11px; color: var(--text-mid); }
.render-spinner { width: 16px; height: 16px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin .8s linear infinite; flex-shrink: 0; }
@keyframes spin { to { transform: rotate(360deg); } }
#booth-render { width: 100%; border-radius: 8px; margin-top: 10px; display: block; }
.render-actions-row { margin-top: 10px; display: flex; gap: 8px; }
.btn-download { padding: 7px 14px; background: var(--accent); color: var(--light-text); border: none; border-radius: 6px; font-size: 11px; font-weight: 700; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; gap: 5px; }
.btn-outline-sm { padding: 6px 12px; border: 1.5px solid var(--border); border-radius: 6px; background: white; font-size: 11px; font-weight: 600; color: var(--text-dark); cursor: pointer; }
.render-error { background: #fff0f2; border: 1px solid #fecdd3; border-radius: 7px; padding: 10px 14px; font-size: 11px; color: #991b1b; margin-top: 10px; line-height: 1.6; }

/* CARDS */
.two-col-cards { display: grid; grid-template-columns: 1fr 1fr; gap: 13px; }
.card { background: var(--surface); border-radius: 10px; box-shadow: var(--sh); overflow: hidden; }
.card-header { padding: 9px 14px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; }
.card-header h3 { font-size: 12px; font-weight: 700; }
.card-body { padding: 12px 14px; }
.concept-text { font-size: 12px; line-height: 1.8; color: var(--text-dark); margin-bottom: 10px; }
.tips-list { list-style: none; padding-top: 9px; border-top: 1px solid var(--border); display: flex; flex-direction: column; gap: 6px; }
.tip-item { font-size: 11px; color: #2d4a60; padding-left: 14px; position: relative; line-height: 1.45; }
.tip-item::before { content: '›'; color: var(--accent); position: absolute; left: 0; font-weight: 900; font-size: 13px; top: -1px; }
.fp-body { padding: 8px 10px; }
.fp-body svg { width: 100%; height: auto; display: block; border-radius: 6px; }

/* ORDER LIST */
.item-count-badge { background: var(--secondary); color: var(--light-text); font-size: 10px; font-weight: 700; padding: 2px 7px; border-radius: 20px; }
.order-list  { max-height: 220px; overflow-y: auto; }
.order-item  { display: flex; align-items: flex-start; gap: 8px; padding: 7px 14px; border-bottom: 1px solid #f0f3f7; }
.order-item:last-child { border-bottom: none; }
.order-item:hover { background: #fafbfd; }
.oi-icon   { width: 26px; height: 26px; background: var(--bg); border-radius: 6px; display: flex; align-items: center; justify-content: center; font-size: 13px; flex-shrink: 0; margin-top: 1px; }
.oi-info   { flex: 1; min-width: 0; }
.oi-name   { font-size: 11px; font-weight: 600; color: var(--text-dark); line-height: 1.3; }
.oi-detail { font-size: 10px; color: var(--text-mid); margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.oi-qty    { font-size: 11px; font-weight: 700; color: var(--accent); white-space: nowrap; padding-top: 2px; flex-shrink: 0; }

/* SUMMARY CARD */
.summary-card  { background: var(--surface); border-radius: 10px; box-shadow: var(--sh); padding: 13px 14px; display: flex; flex-direction: column; gap: 8px; }
.summary-title { font-size: 12px; font-weight: 700; padding-bottom: 8px; border-bottom: 1px solid var(--border); }
.summary-row   { display: flex; justify-content: space-between; font-size: 11px; color: var(--text-mid); gap: 8px; align-items: flex-start; }
.summary-row strong { color: var(--text-dark); font-weight: 600; text-align: right; }
.cta-btn  { width: 100%; padding: 11px; background: var(--primary); color: var(--light-text); border: none; border-radius: var(--r); font-size: 12px; font-weight: 700; cursor: pointer; margin-top: 4px; transition: background .2s; letter-spacing: .3px; }
.cta-btn:hover { background: var(--secondary); }
.cta-hint { font-size: 10px; color: var(--text-mid); text-align: center; }

/* CHAT PANEL */
.chat-panel { border-top: 2px solid var(--border); background: var(--surface); flex-shrink: 0; }
.chat-header { background: var(--primary); padding: 8px 14px; display: flex; align-items: center; justify-content: space-between; }
.chat-header > span:first-child { font-size: 12px; font-weight: 700; color: var(--light-text); }
.chat-model { font-size: 10px; color: var(--highlight); font-style: italic; }
.chat-history { overflow-y: auto; padding: 8px 12px; display: flex; flex-direction: column; gap: 6px; min-height: 36px; max-height: 155px; }
.chat-bubble { max-width: 85%; padding: 7px 11px; border-radius: 12px; font-size: 11px; line-height: 1.5; word-break: break-word; }
.chat-bubble.user { background: var(--secondary); color: var(--light-text); align-self: flex-end; border-bottom-right-radius: 3px; }
.chat-bubble.assistant { background: var(--bg); color: var(--text-dark); align-self: flex-start; border-bottom-left-radius: 3px; }
.chat-bubble.thinking { background: var(--bg); color: var(--text-mid); align-self: flex-start; font-style: italic; }
.chat-input-row { display: flex; gap: 6px; padding: 8px 12px; border-top: 1px solid var(--border); }
.chat-input { flex: 1; padding: 7px 10px; border: 1.5px solid var(--border); border-radius: 6px; font-size: 11px; font-family: inherit; outline: none; color: var(--text-dark); }
.chat-input:focus { border-color: var(--accent); }
.chat-send-btn { padding: 7px 16px; background: var(--secondary); color: var(--light-text); border: none; border-radius: 6px; font-size: 11px; font-weight: 700; cursor: pointer; transition: background .2s; white-space: nowrap; }
.chat-send-btn:hover:not(:disabled) { background: var(--primary); }
.chat-send-btn:disabled { background: #b0bec5; cursor: not-allowed; }

/* LOADING OVERLAY */
.loading-overlay { position: fixed; inset: 0; background: rgba(17,66,97,.65); z-index: 200; display: flex; align-items: center; justify-content: center; }
.loading-box    { background: white; border-radius: 14px; padding: 28px 32px; text-align: center; max-width: 300px; width: 90%; box-shadow: var(--sh-md); }
.loading-logo   { height: 34px; margin-bottom: 16px; }
.loading-spinner { width: 36px; height: 36px; border: 3px solid var(--bg); border-top-color: var(--secondary); border-radius: 50%; animation: spin .9s linear infinite; margin: 0 auto 14px; }
.loading-title  { font-size: 13px; font-weight: 700; color: var(--primary); margin-bottom: 4px; }
.loading-sub    { font-size: 11px; color: var(--text-mid); line-height: 1.55; }
.loading-steps  { margin-top: 14px; text-align: left; display: flex; flex-direction: column; gap: 7px; }
.loading-step   { font-size: 11px; color: var(--text-mid); }
.loading-step.done   { color: #16a34a; }
.loading-step.active { color: var(--secondary); font-weight: 600; }

/* TOAST */
.toast { position: fixed; top: 62px; left: 50%; transform: translateX(-50%); z-index: 300; padding: 9px 18px; border-radius: 8px; font-size: 12px; font-weight: 600; max-width: 500px; width: 90%; text-align: center; box-shadow: var(--sh-md); }

/* FOOTER */
footer { background: var(--primary); padding: 10px 20px; display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; }
footer p { color: rgba(168,183,195,.55); font-size: 10px; }
footer strong { color: var(--highlight); font-weight: 600; }

/* SCROLLBAR */
::-webkit-scrollbar { width: 4px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--highlight); border-radius: 2px; }
</style>
</head>
<body>

<!-- NAV -->
<nav>
  <div class="nav-left">
    <img src="/logo.webp" class="nav-logo" alt="GES"
         onerror="this.style.display='none';this.nextElementSibling.style.display='inline'">
    <span style="display:none;font-weight:800;font-size:18px;color:#F3F4F3;letter-spacing:2px">GES</span>
    <div class="nav-divider"></div>
    <span class="nav-title">Booth Visualizer</span>
    <span class="nav-badge">AI-Powered</span>
  </div>
  <div class="nav-right"></div>
</nav>

<div class="tagline-bar">
  Designed by <strong>TradeTech Transformers</strong> &mdash; Modernizing events through AI.
</div>

<!-- APP BODY -->
<div class="app-body">

  <!-- LEFT PANEL -->
  <div class="left-panel">

    <!-- Reference Photo -->
    <div class="form-section">
      <div class="section-label">Reference Photo (optional)</div>
      <div class="upload-zone" id="img-zone">
        <input type="file" id="img-file" accept="image/*">
        <div class="upload-icon">&#127963;</div>
        <div class="upload-title">Upload booth photo or inspiration</div>
        <div class="upload-hint">JPG, PNG &middot; style &amp; brand cues incorporated</div>
      </div>
      <div id="img-preview-wrap" style="display:none">
        <div class="preview-wrap">
          <img id="img-preview" src="" alt="">
          <button class="preview-remove" id="img-remove" title="Remove">&#10005;</button>
        </div>
      </div>
    </div>

    <!-- Booth Details -->
    <div class="form-section">
      <div class="section-label">Booth Details</div>
      <div class="two-col-fields">
        <div class="field">
          <label>Width (ft)</label>
          <input type="number" id="booth-width" placeholder="20" min="1">
        </div>
        <div class="field">
          <label>Depth (ft)</label>
          <input type="number" id="booth-depth" placeholder="20" min="1">
        </div>
      </div>
      <div class="field">
        <label>Show / Event Name</label>
        <input type="text" id="show-name" placeholder="e.g. NAB Show 2026">
      </div>
      <div class="two-col-fields">
        <div class="field">
          <label>Booth Type</label>
          <select id="booth-type">
            <option value="">Select...</option>
            <option>Inline / Linear</option>
            <option>Corner</option>
            <option>Island (open all 4 sides)</option>
            <option>Peninsula (open 3 sides)</option>
            <option>Custom / Split Island</option>
          </select>
        </div>
        <div class="field">
          <label>Booth Number</label>
          <input type="text" id="booth-number" placeholder="e.g. 1245">
        </div>
      </div>
    </div>

    <!-- Exhibitor Profile -->
    <div class="form-section">
      <div class="section-label">Exhibitor Profile</div>
      <div class="field">
        <label>Industry</label>
        <select id="industry">
          <option value="">Select industry...</option>
          <option>Technology</option>
          <option>Healthcare</option>
          <option>Manufacturing</option>
          <option>Automotive</option>
          <option>Education</option>
        </select>
      </div>
      <div class="field">
        <label>Marketing Goals (select all that apply)</label>
        <div class="chip-group" style="margin-top:3px">
          <div class="chip goal-chip" data-val="Collect leads">Collect Leads</div>
          <div class="chip goal-chip" data-val="Product launch">Product Launch</div>
          <div class="chip goal-chip" data-val="Brand awareness">Brand Awareness</div>
          <div class="chip goal-chip" data-val="Live demonstrations">Live Demos</div>
        </div>
      </div>
      <div class="field">
        <label>Brand Colors</label>
        <input type="text" id="brand-colors" placeholder="e.g. navy blue and gold">
      </div>
    </div>

    <!-- Style / Vibe -->
    <div class="form-section">
      <div class="section-label">Style &amp; Vibe</div>
      <div class="chip-group">
        <div class="chip vibe-chip" data-val="bold and high-impact">Bold &amp; High-Impact</div>
        <div class="chip vibe-chip" data-val="clean and professional">Clean &amp; Professional</div>
        <div class="chip vibe-chip" data-val="warm and inviting">Warm &amp; Inviting</div>
        <div class="chip vibe-chip" data-val="tech-forward and modern">Tech-Forward</div>
        <div class="chip vibe-chip" data-val="luxury and premium">Luxury &amp; Premium</div>
      </div>
    </div>

    <!-- Vision -->
    <div class="form-section" style="flex:1;display:flex;flex-direction:column">
      <div class="section-label">Your Vision</div>
      <div class="field" style="flex:1">
        <textarea id="vision" placeholder="e.g. 20x20 island booth with a large LED video wall, 3 interactive product demo stations, an executive meeting lounge with seating, and a prominent hanging sign. Open and inviting layout with easy traffic flow."></textarea>
      </div>
    </div>

    <button class="gen-btn" id="gen-btn" disabled>&#10022; Generate Booth Concept</button>

  </div><!-- /left-panel -->

  <!-- RIGHT PANEL -->
  <div class="right-panel">
    <div id="results-area">

      <!-- Empty state -->
      <div id="empty-state" style="display:flex">
        <div class="empty-icon">&#127959;</div>
        <h2 class="empty-title">Your Booth Awaits</h2>
        <p class="empty-desc">Describe your vision in the panel on the left and get a complete booth concept, order list, and photorealistic render instantly.</p>
        <div class="empty-hint">&#10022;&nbsp; Fill in your booth details and click Generate</div>
        <div class="empty-features">
          <div class="empty-feature"><div class="ef-icon">&#127775;</div>Concept</div>
          <div class="empty-feature"><div class="ef-icon">&#128230;</div>Order List</div>
          <div class="empty-feature"><div class="ef-icon">&#128248;</div>Render</div>
          <div class="empty-feature"><div class="ef-icon">&#128172;</div>Refinement</div>
        </div>
      </div>

      <!-- Results -->
      <div id="results-panel" style="display:none;flex-direction:column">

        <div class="results-header">
          <div>
            <h2 class="results-title">Your Booth Concept</h2>
            <p id="results-subtitle" class="results-sub"></p>
          </div>
          <div class="results-actions">
            <button class="btn-outline" id="reset-btn">Start Over</button>
            <button class="btn-primary" onclick="window.open('https://ordering.ges.com','_blank')">Submit Order &#8594;</button>
          </div>
        </div>

        <div class="results-body">

          <!-- FLUX Render -->
          <div class="render-card">
            <div class="render-card-header">
              <span>Style &amp; Atmosphere Reference</span>
              <span class="flux-badge">Stable Image Ultra</span>
            </div>
            <div class="render-card-body">
              <div id="rerender-bar" style="display:none" class="rerender-bar">
                <span>Design updated &mdash; render is from the previous version</span>
                <button class="btn-sm" onclick="generateImage()">&#128248; Re-render</button>
              </div>
              <div id="render-idle" class="render-idle-row">
                <button class="btn-render" id="render-btn" onclick="generateImage()" disabled>
                  &#128248; Generate Photorealistic Render
                </button>
                <span class="render-hint">Style &amp; atmosphere reference &middot; AI cannot render readable text/signage &middot; ~10&#8211;20 sec</span>
              </div>
              <div id="render-progress" style="display:none" class="render-progress">
                <div class="render-spinner"></div>
                <span id="render-status">Submitting to FLUX 1.1 Pro...</span>
              </div>
              <img id="booth-render" src="" alt="Photorealistic booth render" style="display:none">
              <div id="render-actions" style="display:none" class="render-actions-row">
                <button class="btn-download" id="download-btn" onclick="downloadRender()">&#11015; Download</button>
                <button class="btn-outline-sm" onclick="generateImage()">&#8635; Regenerate</button>
              </div>
              <div id="render-error" style="display:none" class="render-error"></div>
            </div>
          </div>

          <!-- Concept + Floor Plan -->
          <div class="two-col-cards">
            <div class="card">
              <div class="card-header"><h3>&#128172; Booth Concept</h3></div>
              <div class="card-body">
                <p id="concept-text" class="concept-text"></p>
                <ul id="tips-list" class="tips-list"></ul>
              </div>
            </div>
          </div>

          <!-- Order Items + Summary -->
          <div class="two-col-cards">
            <div class="card">
              <div class="card-header">
                <h3>&#128230; Order Items</h3>
                <span id="item-count" class="item-count-badge">0</span>
              </div>
              <div id="order-list" class="order-list"></div>
            </div>
            <div class="summary-card">
              <h3 class="summary-title">&#128203; Summary</h3>
              <div id="summary-rows"></div>
              <button class="cta-btn" onclick="window.open('https://ordering.ges.com','_blank')">
                &#8594;&nbsp; Place Order with GES &nbsp;&#8594;
              </button>
              <p class="cta-hint">Continue to GES Ordering to finalize and place your order</p>
            </div>
          </div>

        </div><!-- /results-body -->
      </div><!-- /results-panel -->

    </div><!-- /results-area -->

    <!-- Chat Panel (shown after first generation) -->
    <div id="chat-panel" style="display:none;flex-direction:column" class="chat-panel">
      <div class="chat-header">
        <span>&#10022; Refine Your Booth</span>
        <span class="chat-model">multi-turn conversation</span>
      </div>
      <div id="chat-history" class="chat-history"></div>
      <div class="chat-input-row">
        <input type="text" id="chat-input" class="chat-input"
               placeholder="e.g. &quot;Add 2 more chairs&quot; or &quot;Make it look more premium&quot;" maxlength="500">
        <button class="chat-send-btn" id="chat-send-btn">Send</button>
      </div>
    </div>

  </div><!-- /right-panel -->
</div><!-- /app-body -->

<footer>
  <p>&copy; 2025 GES &mdash; Global Experience Specialists. All rights reserved.</p>
  <p>Designed by <strong>TradeTech Transformers</strong> &mdash; Modernizing events through AI.</p>
</footer>

<!-- Loading overlay -->
<div id="loading-overlay" style="display:none" class="loading-overlay">
  <div class="loading-box">
    <img src="/logo.webp" class="loading-logo" alt="GES" onerror="this.style.display='none'">
    <div class="loading-spinner"></div>
    <h3 class="loading-title">Designing your booth...</h3>
    <p class="loading-sub">Analyzing your specifications and generating a custom concept.</p>
    <div class="loading-steps">
      <div class="loading-step done" id="ls1">&#10003; Reading your specifications</div>
      <div class="loading-step active" id="ls2">&#9679; Generating booth layout &amp; concept</div>
      <div class="loading-step" id="ls3">&#9675; Building order list</div>
    </div>
  </div>
</div>

<!-- Toast -->
<div id="toast" style="display:none" class="toast"></div>

<script>
// ─── State ────────────────────────────────────────────────────────────────────
var uploadedImageBase64    = null;
var uploadedImageMediaType = 'image/jpeg';
var selectedVibe           = '';
var selectedGoals          = [];
var imagePrompt            = '';
var imageNegativePrompt    = '';
var currentRenderDataUrl   = null;
var conversationHistory    = [];


// ─── Reference Image Upload ───────────────────────────────────────────────────
var imgZone = document.getElementById('img-zone');
document.getElementById('img-file').addEventListener('change', function(e) {
  if (e.target.files[0]) handleImageFile(e.target.files[0]);
});
imgZone.addEventListener('dragover', function(e) { e.preventDefault(); imgZone.classList.add('dragover'); });
imgZone.addEventListener('dragleave', function() { imgZone.classList.remove('dragover'); });
imgZone.addEventListener('drop', function(e) {
  e.preventDefault(); imgZone.classList.remove('dragover');
  var f = e.dataTransfer.files[0];
  if (f && f.type.startsWith('image/')) handleImageFile(f);
});
function handleImageFile(file) {
  uploadedImageMediaType = file.type || 'image/jpeg';
  var reader = new FileReader();
  reader.onload = function(e) {
    uploadedImageBase64 = e.target.result.split(',')[1];
    document.getElementById('img-preview').src = e.target.result;
    imgZone.style.display = 'none';
    document.getElementById('img-preview-wrap').style.display = 'block';
  };
  reader.readAsDataURL(file);
}
document.getElementById('img-remove').addEventListener('click', function() {
  uploadedImageBase64 = null;
  document.getElementById('img-file').value = '';
  document.getElementById('img-preview-wrap').style.display = 'none';
  imgZone.style.display = 'block';
});


// ─── Chips ────────────────────────────────────────────────────────────────────
document.querySelectorAll('.vibe-chip').forEach(function(chip) {
  chip.addEventListener('click', function() {
    document.querySelectorAll('.vibe-chip').forEach(function(c) { c.classList.remove('active'); });
    chip.classList.add('active');
    selectedVibe = chip.dataset.val;
  });
});
document.querySelectorAll('.goal-chip').forEach(function(chip) {
  chip.addEventListener('click', function() {
    chip.classList.toggle('active');
    var val = chip.dataset.val;
    if (chip.classList.contains('active')) {
      if (selectedGoals.indexOf(val) === -1) selectedGoals.push(val);
    } else {
      selectedGoals = selectedGoals.filter(function(v) { return v !== val; });
    }
  });
});

// ─── Vision textarea ──────────────────────────────────────────────────────────
var visionEl = document.getElementById('vision');
visionEl.addEventListener('input', function() {
  document.getElementById('gen-btn').disabled = visionEl.value.trim().length < 10;
});
document.getElementById('gen-btn').addEventListener('click', generate);

// ─── Helpers ──────────────────────────────────────────────────────────────────
function parseJSONResponse(text) {
  var clean = text.replace(/\`\`\`json\s*/gi, '').replace(/\`\`\`\s*/g, '').trim();
  // Strategy 1: direct parse
  try { return JSON.parse(clean); } catch(e) {}
  // Strategy 2: extract from first { to last }
  var start = clean.indexOf('{');
  var end   = clean.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(clean.substring(start, end + 1)); } catch(e) {
      throw new Error('JSON parse error: ' + e.message + '. Preview: ' + text.slice(0, 400));
    }
  }
  throw new Error('No JSON found in Claude response. Length: ' + text.length + '. Preview: ' + text.slice(0, 400));
}

function buildImagePromptPrefix(w, d, boothType, brandColors) {
  var sqft = (parseFloat(w) || 0) * (parseFloat(d) || 0);
  var sizeDesc = sqft <= 100 ? 'small compact 10x10' : sqft <= 200 ? 'medium 10x20' : sqft <= 400 ? 'medium 20x20' : 'large';
  var typeDesc = boothType ? boothType.split('/')[0].trim().toLowerCase() : 'inline';
  var prefix = 'Small trade show booth, ' + w + 'x' + d + ' ft ' + typeDesc + ' booth, ' + sizeDesc + ' size, modest footprint, tight layout. ';
  if (brandColors) prefix += 'Brand colors: ' + brandColors + '. ';
  return prefix;
}

function buildSystemPrompt(w, d, goals, boothNumber) {
  var sqft  = (parseFloat(w) || 0) * (parseFloat(d) || 0);
  var rules = '';
  if (sqft > 400) {
    rules += '\\n- LARGE BOOTH (>20x20 ft): You MUST include a dedicated meeting/lounge area with seating, at least one 55"+ monitor, and a storage closet.';
  }
  if (goals.indexOf('Live demonstrations') !== -1) {
    rules += '\\n- LIVE DEMOS GOAL: You MUST include dedicated 20A power circuits, AV equipment (monitor + audio), and audience seating facing the demo station.';
  }
  if (boothNumber) {
    rules += '\\n- BOOTH #' + boothNumber + ': Include location-smart recommendations based on typical trade show layouts (aisle orientation, hero placement).';
  }
  return 'You are a GES (Global Experience Specialists) certified trade show booth design expert with 20+ years of experience. GES is the world\\'s leading full-service event solutions company.\\n\\nYour designs are professional, ADA-compliant, physically buildable, and always drive the exhibitor\\'s marketing goals.\\n\\nEXHIBITOR SPECIFICATIONS ARE LOCKED: If the exhibitor explicitly names an item or quantity (e.g. "1 chair", "2 tables", "LED wall"), that exact item and quantity MUST appear in order_items unchanged. Do not remove, rename, or change the quantity of anything explicitly requested. You may add items the exhibitor did not mention, and you may note recommendations — but never override what was explicitly asked for.\\n\\nCRITICAL: Respond ONLY with valid JSON. No markdown, no code fences, no text before or after the JSON object.' +
    (rules ? '\\n\\nSMART DESIGN RULES (apply automatically):\\n' + rules : '');
}

function buildFirstUserContent(showName, w, d, boothType, boothNumber, industry, brandColors, vibe, goals, vision) {
  var promptText =
    'Design a complete GES trade show booth:\\n' +
    '- Show/Event: ' + showName + '\\n' +
    '- Booth Size: ' + w + ' ft x ' + d + ' ft\\n' +
    '- Booth Type: ' + boothType + '\\n' +
    (boothNumber ? '- Booth Number: ' + boothNumber + '\\n' : '') +
    (industry    ? '- Industry: ' + industry + '\\n' : '') +
    (brandColors ? '- Brand Colors: ' + brandColors + '\\n' : '') +
    '- Style/Vibe: ' + vibe + '\\n' +
    (goals.length ? '- Marketing Goals: ' + goals.join(', ') + '\\n' : '') +
    '- Exhibitor Vision: ' + vision + '\\n\\n' +
    'Return ONLY valid JSON matching this exact structure:\\n' +
    '{\\n' +
    '  "concept": "4-6 vivid sentences describing layout, atmosphere, visitor flow, hero element, and key design moments",\\n' +
    '  "image_prompt": "Photorealistic trade show booth interior photograph, exhibition hall, 8K architectural visualization. CRITICAL: reflect exact quantities from order_items — if the order has 1 chair include exactly 1 chair, if 2 tables include exactly 2 tables. Start with: [exact item counts, e.g. \\'one reception counter, two high-top tables, one large monitor\\']. Then describe: booth structure, backwall graphics, flooring, lighting, brand colors, atmosphere.",\\n' +
    '  "design_tips": ["specific actionable tip 1", "tip 2", "tip 3"],\\n' +
    '  "order_items": [{"name":"item name","category":"Furniture|Flooring|Signage|Lighting|AV|Electrical|Display|Storage","qty":"N","detail":"specific detail about configuration","icon":"single emoji"}],\\n' +
    '  "summary": {"booth_size":"' + w + 'x' + d + ' ft","booth_type":"' + boothType + '","estimated_items":"N items","key_features":["feature 1","feature 2","feature 3"]}\\n' +
    '}\\n\\n' +
    'Order items: include 8-14 specific, procurable items. More items for larger booths. Cover: flooring, structure/graphics, furniture, lighting, AV/monitors, electrical, display fixtures, storage.';

  var content = [{ type: 'text', text: promptText }];

  if (uploadedImageBase64) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: uploadedImageMediaType, data: uploadedImageBase64 }
    });
    content.push({
      type: 'text',
      text: 'The image above is the exhibitor\\'s reference (existing booth, brand assets, or inspiration). Incorporate its color palette, design language, and style cues into the new booth design where appropriate.'
    });
  }

  return content;
}

// ─── Generate (first turn) ────────────────────────────────────────────────────
async function generate() {
  var w           = document.getElementById('booth-width').value   || 'unspecified';
  var d           = document.getElementById('booth-depth').value   || 'unspecified';
  var showName    = document.getElementById('show-name').value     || 'the upcoming show';
  var boothType   = document.getElementById('booth-type').value    || 'standard booth';
  var boothNumber = document.getElementById('booth-number').value  || '';
  var industry    = document.getElementById('industry').value      || '';
  var brandColors = document.getElementById('brand-colors').value  || '';
  var vision      = visionEl.value.trim();
  var vibe        = selectedVibe || 'professional';

  showLoading();

  var firstContent  = buildFirstUserContent(showName, w, d, boothType, boothNumber, industry, brandColors, vibe, selectedGoals, vision);
  var systemPrompt  = buildSystemPrompt(w, d, selectedGoals, boothNumber);

  var concept;
  try {
    var r = await fetch('/api/claude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 8192,
        system: systemPrompt,
        messages: [{ role: 'user', content: firstContent }]
      })
    });
    var data = await r.json();
    if (!r.ok) {
      var msg = (data.error && data.error.message) ? data.error.message : JSON.stringify(data.error || data);
      throw new Error(msg);
    }
    var text = (data.content && data.content[0] && data.content[0].text) ? data.content[0].text : '';
    concept = parseJSONResponse(text);

    // Seed conversation history — text-only for first user msg to keep refinements lean
    var historyUserMsg = '(Initial generation) Show: ' + showName + ' | Size: ' + w + 'x' + d + ' | Type: ' + boothType +
      (boothNumber ? ' | Booth #' + boothNumber : '') + (industry ? ' | Industry: ' + industry : '') +
      (brandColors ? ' | Colors: ' + brandColors : '') + ' | Vibe: ' + vibe +
      (selectedGoals.length ? ' | Goals: ' + selectedGoals.join(', ') : '') + ' | Vision: ' + vision;
    conversationHistory = [
      { role: 'user',      content: historyUserMsg },
      { role: 'assistant', content: text }
    ];
  } catch(e) {
    hideLoading();
    showToast('Generation failed: ' + e.message.slice(0, 180), 'error');
    return;
  }

  hideLoading();
  var furnitureItems = (concept.order_items || []).filter(function(i){ return i.category === 'Furniture'; });
  var furnitureSpec  = furnitureItems.map(function(i){ return i.qty + ' ' + i.name.toLowerCase(); }).join(', ');
  var negParts = [];
  furnitureItems.forEach(function(i) {
    var qty = parseInt(i.qty) || 1;
    var n = i.name.toLowerCase();
    for (var q = qty + 1; q <= qty + 4; q++) negParts.push(q + ' ' + n + 's');
    negParts.push('extra ' + n);
  });
  imageNegativePrompt = negParts.join(', ') + (negParts.length ? ', overcrowded, too much furniture, cluttered' : '');
  imagePrompt = buildImagePromptPrefix(w, d, boothType, brandColors) +
    (furnitureSpec ? 'EXACT FURNITURE ONLY — ' + furnitureSpec + '. No additional chairs or tables. ' : '') +
    (concept.image_prompt || '');
  renderConcept(concept, showName, w, d, boothType, false);

  generateImage();

  document.getElementById('chat-panel').style.display = 'flex';
  document.getElementById('chat-history').innerHTML   = '';
  document.getElementById('rerender-bar').style.display = 'none';
}

// ─── Render Concept ───────────────────────────────────────────────────────────
function renderConcept(r, showName, w, d, boothType, isRefinement) {
  document.getElementById('empty-state').style.display  = 'none';
  document.getElementById('results-panel').style.display = 'flex';

  document.getElementById('results-subtitle').textContent =
    showName + ' • ' + w + '×' + d + ' ft • ' + boothType;

  document.getElementById('concept-text').textContent = r.concept || '';

  var tipsEl = document.getElementById('tips-list');
  tipsEl.innerHTML = (r.design_tips || []).map(function(t) {
    return '<li class="tip-item">' + escHtml(t) + '</li>';
  }).join('');

  var items = r.order_items || [];
  document.getElementById('item-count').textContent = items.length;
  document.getElementById('order-list').innerHTML = items.map(function(i) {
    return '<div class="order-item">' +
      '<div class="oi-icon">' + (i.icon || '\u{1F4E6}') + '</div>' +
      '<div class="oi-info">' +
        '<div class="oi-name">'   + escHtml(i.name)   + '</div>' +
        '<div class="oi-detail">' + escHtml(i.category) + ' — ' + escHtml(i.detail) + '</div>' +
      '</div>' +
      '<div class="oi-qty">' + escHtml(String(i.qty)) + '</div>' +
    '</div>';
  }).join('');

  var s = r.summary || {};
  var rows = [
    ['Booth Size',   s.booth_size    || (w + '×' + d + ' ft')],
    ['Booth Type',   s.booth_type    || boothType],
    ['Total Items',  s.estimated_items || (items.length + ' items')]
  ];
  if (s.key_features && s.key_features.length) {
    rows.push(['Key Features', s.key_features.join(' · ')]);
  }
  document.getElementById('summary-rows').innerHTML = rows.map(function(row) {
    return '<div class="summary-row"><span>' + escHtml(row[0]) + '</span><strong>' + escHtml(row[1]) + '</strong></div>';
  }).join('');

  if (!isRefinement) {
    imagePrompt = r.image_prompt || '';
    currentRenderDataUrl = null;
    document.getElementById('render-btn').disabled          = !imagePrompt;
    document.getElementById('render-idle').style.display    = 'flex';
    document.getElementById('render-progress').style.display = 'none';
    document.getElementById('booth-render').style.display   = 'none';
    document.getElementById('render-actions').style.display = 'none';
    document.getElementById('render-error').style.display   = 'none';
  } else {
    // New concept is ready; update imagePrompt but keep existing render visible
    if (r.image_prompt) {
      var w2 = document.getElementById('booth-width').value  || 'unspecified';
      var d2 = document.getElementById('booth-depth').value  || 'unspecified';
      imagePrompt = buildImagePromptPrefix(w2, d2, document.getElementById('booth-type').value || '', document.getElementById('brand-colors').value || '') + r.image_prompt;
    }
  }
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── Chat Refinement ──────────────────────────────────────────────────────────
async function sendRefinement() {
  var input = document.getElementById('chat-input');
  var msg   = input.value.trim();
  if (!msg || !conversationHistory.length) return;

  appendChatBubble('user', msg);
  input.value = '';

  var thinkingEl = appendChatBubble('thinking', 'Updating your booth design...');
  document.getElementById('chat-send-btn').disabled = true;

  var w = document.getElementById('booth-width').value  || 'unspecified';
  var d = document.getElementById('booth-depth').value  || 'unspecified';

  var refinementMsg = {
    role: 'user',
    content: msg + '\\n\\nReturn the COMPLETE updated booth design in the exact same JSON structure. Every field is required.'
  };
  conversationHistory.push(refinementMsg);

  try {
    var r = await fetch('/api/claude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 8192,
        system: buildSystemPrompt(w, d, selectedGoals, document.getElementById('booth-number').value || ''),
        messages: conversationHistory
      })
    });
    var data = await r.json();
    if (!r.ok) {
      var errMsg = (data.error && data.error.message) ? data.error.message : JSON.stringify(data.error || data);
      throw new Error(errMsg);
    }
    var text    = (data.content && data.content[0] && data.content[0].text) ? data.content[0].text : '';
    var concept = parseJSONResponse(text);
    conversationHistory.push({ role: 'assistant', content: text });

    thinkingEl.remove();
    appendChatBubble('assistant', 'Done! Booth updated.');

    renderConcept(concept,
      document.getElementById('show-name').value  || '',
      w, d,
      document.getElementById('booth-type').value || '',
      true
    );
    document.getElementById('rerender-bar').style.display = 'flex';
  } catch(e) {
    thinkingEl.remove();
    appendChatBubble('assistant', 'Error: ' + e.message.slice(0, 150));
    conversationHistory.pop();
    showToast('Refinement failed: ' + e.message.slice(0, 100), 'error');
  }

  document.getElementById('chat-send-btn').disabled = false;
}

function appendChatBubble(cls, text) {
  var h   = document.getElementById('chat-history');
  var div = document.createElement('div');
  div.className   = 'chat-bubble ' + cls;
  div.textContent = text;
  h.appendChild(div);
  h.scrollTop = h.scrollHeight;
  return div;
}

document.getElementById('chat-send-btn').addEventListener('click', sendRefinement);
document.getElementById('chat-input').addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendRefinement(); }
});

// ─── Stability AI Image Generation ───────────────────────────────────────────
async function generateImage() {
  if (!imagePrompt) { showToast('Generate a booth concept first', 'warn'); return; }

  document.getElementById('render-idle').style.display     = 'none';
  document.getElementById('render-progress').style.display = 'flex';
  document.getElementById('render-error').style.display    = 'none';
  document.getElementById('booth-render').style.display    = 'none';
  document.getElementById('render-actions').style.display  = 'none';
  document.getElementById('rerender-bar').style.display    = 'none';
  document.getElementById('render-status').textContent     = 'Generating with Stable Image Ultra...';

  try {
    var r = await fetch('/api/image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: imagePrompt, negative_prompt: imageNegativePrompt })
    });
    var data = await r.json();
    if (!r.ok || !data.image_b64) throw new Error(data.error || 'No image data returned from Stability AI');

    var dataUrl = 'data:' + data.content_type + ';base64,' + data.image_b64;
    currentRenderDataUrl = dataUrl;

    var img = document.getElementById('booth-render');
    img.src = dataUrl;
    img.style.display = 'block';

    document.getElementById('render-progress').style.display = 'none';
    document.getElementById('render-idle').style.display     = 'flex';
    document.getElementById('render-actions').style.display  = 'flex';
  } catch(e) {
    document.getElementById('render-progress').style.display = 'none';
    document.getElementById('render-idle').style.display     = 'flex';
    var errEl = document.getElementById('render-error');
    errEl.innerHTML = '<strong>Render failed:</strong> ' + escHtml(e.message) +
      '<br><small style="color:#7f1d1d;opacity:.8">Check your Stability AI key and credits at platform.stability.ai</small>';
    errEl.style.display = 'block';
  }
}

function downloadRender() {
  if (!currentRenderDataUrl) return;
  var a = document.createElement('a');
  a.href     = currentRenderDataUrl;
  a.download = 'booth-render.jpg';
  a.click();
}

// ─── Loading / Toast ──────────────────────────────────────────────────────────
function showLoading() {
  document.getElementById('loading-overlay').style.display = 'flex';
  document.getElementById('gen-btn').disabled = true;
}
function hideLoading() {
  document.getElementById('loading-overlay').style.display = 'none';
  document.getElementById('gen-btn').disabled = visionEl.value.trim().length < 10;
}
function showToast(msg, type) {
  var t = document.getElementById('toast');
  t.textContent = msg;
  var c = type === 'error' ? ['#fee2e2','#991b1b','#fca5a5']
        : type === 'ok'    ? ['#dcfce7','#166534','#86efac']
        :                    ['#fef9c3','#713f12','#fde68a'];
  t.style.background = c[0];
  t.style.color      = c[1];
  t.style.border     = '1px solid ' + c[2];
  t.style.display    = 'block';
  clearTimeout(t._t);
  t._t = setTimeout(function() { t.style.display = 'none'; }, 5000);
}

// ─── Reset ────────────────────────────────────────────────────────────────────
document.getElementById('reset-btn').addEventListener('click', function() {
  document.getElementById('results-panel').style.display = 'none';
  document.getElementById('empty-state').style.display   = 'flex';
  document.getElementById('chat-panel').style.display    = 'none';
  document.getElementById('chat-history').innerHTML      = '';
  document.getElementById('rerender-bar').style.display  = 'none';
  conversationHistory    = [];
  imagePrompt            = '';
  currentRenderDataUrl   = null;
});
</script>
</body>
</html>`;

// ─── SERVER ────────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── Static: GES logo ────────────────────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/logo.webp') {
    fs.readFile(path.join(__dirname, 'GES-logo.webp'), (err, data) => {
      if (err) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=86400' });
      res.end(data);
    });
    return;
  }

  // ── SPA ──────────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }

  // ── Parse POST body ──────────────────────────────────────────────────────────
  const chunks = [];
  await new Promise(r => { req.on('data', c => chunks.push(c)); req.on('end', r); });
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString()); }
  catch(e) { send(res, 400, { error: 'Invalid JSON body' }); return; }

  // ── Claude proxy ─────────────────────────────────────────────────────────────
  if (req.url === '/api/claude') {
    const apiKey = body.__api_key || process.env.ANTHROPIC_API_KEY || '';
    delete body.__api_key;
    if (!apiKey) { send(res, 400, { error: { message: 'Missing Anthropic API key — set ANTHROPIC_API_KEY env var or enter it in API Keys' } }); return; }
    try {
      console.log('  Claude -> model:', body.model, '| messages:', body.messages && body.messages.length);
      const r = await httpsPost('api.anthropic.com', '/v1/messages',
        { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, body);
      console.log('  Claude <-', r.status);
      if (r.body && r.body.content && r.body.content[0]) {
        const preview = r.body.content[0].text || '';
        console.log('  Claude response preview (first 500 chars):\n' + preview.slice(0, 500));
        console.log('  Claude response length:', preview.length, '| stop_reason:', r.body.stop_reason);
      }
      send(res, r.status, r.body);
    } catch(e) {
      console.error('  Claude error:', e.message);
      send(res, 502, { error: { message: e.message } });
    }
    return;
  }

  // ── Stability AI proxy ───────────────────────────────────────────────────────
  if (req.url === '/api/image') {
    const apiKey = body.__stability_key || process.env.STABILITY_API_KEY || '';
    const { prompt, negative_prompt } = body;
    if (!apiKey) { send(res, 400, { error: 'Missing Stability AI API key — set STABILITY_API_KEY env var or enter it in API Keys' }); return; }
    if (!prompt)  { send(res, 400, { error: 'Missing image prompt' }); return; }
    try {
      console.log('  Stability AI -> submitting...');
      if (negative_prompt) console.log('  Stability AI negative prompt:', negative_prompt.slice(0, 120));
      const r = await stabilityPost(apiKey, prompt, negative_prompt);
      if (r.status !== 200 || !r.body.image) {
        const errMsg = (r.body.errors && r.body.errors[0]) ? r.body.errors[0]
          : (r.body.message || JSON.stringify(r.body));
        console.error('  Stability AI error:', errMsg);
        send(res, r.status, { error: errMsg }); return;
      }
      console.log('  Stability AI -> done, finish_reason:', r.body.finish_reason);
      send(res, 200, { image_b64: r.body.image, content_type: 'image/jpeg' });
    } catch(e) {
      console.error('  Stability AI error:', e.message);
      send(res, 500, { error: e.message });
    }
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => {
  console.log('');
  console.log('  +--------------------------------------+');
  console.log('  |   GES Booth Visualizer v2            |');
  console.log('  |   http://localhost:' + PORT + '              |');
  console.log('  +--------------------------------------+');
  console.log('');
  console.log('  Open the URL above in your browser.');
  console.log('  Press Ctrl+C to stop.');
  console.log('');
});

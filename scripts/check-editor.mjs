import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const server = spawn(process.execPath, ['src/server.mjs'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: '0', SOCKET_PATH: '', DB_PATH: ':memory:', JUDGE_TOKEN: 'ui-test' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const profile = await mkdtemp(join(tmpdir(), 'mini-juiz-chrome-'));
let chrome, ws;
try {
  const [ready] = await Promise.race([once(server.stdout, 'data'), once(server, 'exit').then(() => { throw Error('Server exited'); })]);
  const serverUrl = ready.toString().trim();
  chrome = spawn(process.env.CHROME_BIN ?? '/usr/bin/google-chrome', ['--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let pages;
  for (let i = 0; i < 100; i++) {
    try { const port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(); if (pages.some(p => p.type === 'page')) break; } catch {}
    await delay(100);
  }
  if (!pages) throw Error('Chrome did not start');
  ws = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
  await once(ws, 'open');
  let sequence = 0;
  const pending = new Map();
  const errors = [];
  ws.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
    if (message.id) { const job = pending.get(message.id); pending.delete(message.id); if (message.error) job.reject(Error(JSON.stringify(message.error))); else job.resolve(message.result); }
  });
  const cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => {
    const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: "window.__editorCsp = []; document.addEventListener('securitypolicyviolation', e => window.__editorCsp.push(e.violatedDirective))" });
  await cdp('Page.navigate', { url: serverUrl });
  for (let i = 0; i < 60; i++) { if (await evaluate("document.getElementById('connection')?.classList.contains('connected')")) break; await delay(100); }

  if (!(await evaluate("document.querySelector('.cm-editor') !== null"))) throw Error('IDE editor not present');
  const assert = (value, message) => { if (!value) throw Error(message); };
  const code = () => evaluate("document.getElementById('source').value");
  const press = async (key, keyCode, modifiers = 0, code = key) => {
    await cdp('Input.dispatchKeyEvent', {type:'keyDown',key,code,windowsVirtualKeyCode:keyCode,modifiers});
    await cdp('Input.dispatchKeyEvent', {type:'keyUp',key,code,windowsVirtualKeyCode:keyCode,modifiers});
  };
  const replaceCode = async (text) => {
    await evaluate("document.querySelector('.cm-content').focus()");
    await press('a',65,2,'KeyA');
    await cdp('Input.insertText',{text});
    await delay(60);
  };
  const waitFor = async (expression) => { for(let i=0;i<40;i++){if(await evaluate(expression))return;await delay(50);}throw Error('Timeout: '+expression); };
  assert((await code()).includes('#include <bits/stdc++.h>'),'Default template missing');
  await replaceCode('');
  await press('Tab',9);
  assert(await code() === '    ','Tab must insert four spaces');
  await press('Tab',9,8);
  assert(await code() === '','Shift+Tab must dedent: '+JSON.stringify(await code()));
  await replaceCode('int main() {');
  await press('Enter',13);
  assert((await code()).endsWith('\n    '),'Enter must indent inside braces');
  await replaceCode('');
  await delay(650);
  await cdp('Input.insertText',{text:'('});
  await delay(80);
  assert(await code() === '()','Parenthesis must close automatically');
  await press('z',90,2,'KeyZ');
  assert(await code() === '','Undo must remove bracket pair: '+JSON.stringify(await code()));
  await press('y',89,2,'KeyY');
  assert(await code() === '()','Redo must restore bracket pair: '+JSON.stringify(await code()));
  await replaceCode('cou');
  await press(' ',32,2,'Space');
  await waitFor("document.querySelector('.cm-tooltip-autocomplete')?.textContent.includes('cout')");
  await delay(100);
  await press('Enter',13);
  assert(await code() === 'cout','Autocomplete must insert cout');
  await replaceCode('vec');
  await waitFor("document.querySelector('.cm-tooltip-autocomplete')?.textContent.includes('vector')");
  await delay(100);
  await press('Tab',9);
  assert(await code() === 'vector','Tab must accept completion instead of indenting');
  await replaceCode('fo');
  await press(' ',32,2,'Space');
  await waitFor("document.querySelector('.cm-tooltip-autocomplete')?.textContent.includes('Trecho: laço contado')");
  await delay(100);
  await press('Enter',13);
  assert((await code()).startsWith('for (int i = 0;'),'for snippet must expand');
  await press('Tab',9);
  assert(await evaluate("window.getSelection().toString() === 'n'"),'Tab must advance to next snippet field');
  await press('Tab',9,8);
  assert(await evaluate("window.getSelection().toString() === 'i'"),'Shift+Tab must return to previous snippet field');
  await replaceCode('int a;\nint b;');
  await press('a',65,2,'KeyA');
  await press('Tab',9);
  assert(await code() === '    int a;\n    int b;','Tab must indent selected lines');
  await press('Tab',9,8);
  assert(await code() === 'int a;\nint b;','Shift+Tab must dedent selected lines');
  await press('f',70,2,'KeyF');
  await waitFor("document.querySelector('.cm-search') !== null");
  await press('Escape',27);
  await replaceCode('#include <bits/stdc++.h>\nusing namespace std;\n\nint main() {\n    // comentário\n    cout << "teste";\n    return 0;\n}\n');
  const highlight=await evaluate("({colors:[...document.querySelectorAll('.cm-line span')].map(s=>getComputedStyle(s).color),lines:document.querySelectorAll('.cm-lineNumbers .cm-gutterElement').length})");
  assert(new Set(highlight.colors).size >= 4 && highlight.lines >= 5,'C++ syntax colors and line numbers missing');
  await evaluate("document.querySelector('[data-problem=\"B\"]').click()");
  assert((await code()).includes('#include <bits/stdc++.h>'),'B template missing');
  await replaceCode('// rascunho B');
  await evaluate("document.querySelector('[data-problem=\"A\"]').click()");
  assert((await code()).includes('cout << "teste";'),'A draft lost');
  await evaluate("document.querySelector('[data-problem=\"B\"]').click()");
  assert(await code() === '// rascunho B','B draft lost');
  await press('z',90,2,'KeyZ');
  assert((await code()).includes('#include <bits/stdc++.h>'),'Per-problem undo history lost');
  await evaluate("document.querySelector('[data-problem=\"A\"]').click()");
  await evaluate("document.querySelector('.cm-content').focus()");
  await press('Escape',27);
  await press('Tab',9);
  assert(await evaluate("document.activeElement.id === 'file'"),'Escape then Tab must leave editor');
  await replaceCode('');
  await evaluate("document.getElementById('participant').value='Equipe IDE'; document.getElementById('send').click()");
  assert(await evaluate("document.getElementById('message').textContent.includes('Escreva ou abra')"),'Empty editor validation missing');
  assert(await evaluate("document.getElementById('total').textContent === '0'"),'Empty code must not submit');
  const uploadPath=join(tmpdir(), 'mini-juiz-ide-upload-' + process.pid + '.cpp');
  const uploadedCode='#include <bits/stdc++.h>\nusing namespace std;\nint main(){cout << 42;}';
  await writeFile(uploadPath,uploadedCode);
  await cdp('DOM.enable');
  const {root}=await cdp('DOM.getDocument');
  const {nodeId}=await cdp('DOM.querySelector',{nodeId:root.nodeId,selector:'#file'});
  await evaluate("window.__originalFileText=File.prototype.text; File.prototype.text=function(){return new Promise(resolve=>{window.__finishUpload=async()=>resolve(await window.__originalFileText.call(this))})}");
  await cdp('DOM.setFileInputFiles',{nodeId,files:[uploadPath]});
  await waitFor("typeof window.__finishUpload === 'function'");
  await evaluate("document.querySelector('[data-problem=\"B\"]').click()");
  await evaluate("window.__finishUpload()");
  await delay(100);
  await evaluate("document.querySelector('[data-problem=\"A\"]').click(); File.prototype.text=window.__originalFileText");
  assert(await code() === uploadedCode,'Upload finishing in inactive problem must update its draft');
  await cdp('DOM.setFileInputFiles',{nodeId,files:[uploadPath]});
  await waitFor("document.getElementById('message').textContent.includes('carregado')");
  assert(await code() === uploadedCode,'Upload did not update editor');
  assert(await evaluate("document.querySelector('.cm-content').textContent.includes('cout << 42;')"),'Visible editor not synchronized with upload');
  await evaluate("document.getElementById('send').click()");
  await waitFor("document.getElementById('total').textContent === '1'");
  const response=await fetch(serverUrl + '/internal/claim',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer ui-test'},body:JSON.stringify({worker:'ide-check'})});
  const submitted=await response.json();
  assert(submitted.source===uploadedCode && submitted.problem==='A','Submitted code differs from editor');
  for(const width of [320,375,768,1280,1600]){
    await cdp('Emulation.setDeviceMetricsOverride',{width,height:1100,deviceScaleFactor:1,mobile:false});
    await delay(100);
    assert(await evaluate("document.documentElement.scrollWidth <= innerWidth"),'Editor overflows '+width);
  }
  await cdp('Emulation.setDeviceMetricsOverride',{width:1600,height:1200,deviceScaleFactor:1,mobile:false});
  await replaceCode('#include <bits/stdc++.h>\nusing namespace std;\n\nint main() {\n    vector<int> numeros = {4, 7, 2};\n    sort(numeros.begin(), numeros.end());\n    // Escreva sua solução aqui.\n    cout << numeros.back() << "\\n";\n    return 0;\n}\n');
  await evaluate("window.scrollTo({top:0,behavior:'instant'})");
  await writeFile(join(tmpdir(), 'mini-juiz-ide.png'),Buffer.from((await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:true})).data,'base64'));
  assert(await evaluate("window.__editorCsp.length === 0"),'CSP violation: '+await evaluate('JSON.stringify(window.__editorCsp)'));
  await cdp('Network.enable');
  await cdp('Network.setBlockedURLs',{urls:['*/editor.js']});
  await cdp('Page.reload',{ignoreCache:true});
  await waitFor("document.getElementById('connection')?.classList.contains('connected')");
  assert(await evaluate("!document.getElementById('source').hidden && document.getElementById('source').value.includes('#include <bits/stdc++.h>') && document.getElementById('editor-shortcuts').textContent.includes('Editor básico')"),'Basic editor fallback must preserve working arena');
  if(errors.length) throw Error(JSON.stringify(errors));
  console.log('PASS: Tab 4 espaços, Shift+Tab, Enter, pares, undo/redo, cores, linhas, autocomplete explícito/automático, snippets, rascunhos/históricos A/B, Esc+Tab, validação vazia, upload, envio exato, layouts320–1600 e CSP.');
} finally {
  ws?.close();
  for (const process of [chrome, server]) {
    if (process && process.exitCode === null && process.signalCode === null) { const exited = once(process, 'exit'); process.kill(); await exited; }
  }
  await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}

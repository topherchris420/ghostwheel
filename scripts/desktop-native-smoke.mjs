import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const exe=path.resolve(process.argv[2]||path.join(root,'output','release','portable','ghostwheel.exe'));
if(!exe.toLowerCase().startsWith(root.toLowerCase()+path.sep)||!existsSync(exe))throw new Error('Provide an existing GHOSTWHEEL executable inside this project.');
const port=Number(process.env.GHOSTWHEEL_QA_CDP_PORT||9223);
const installed=exe.toLowerCase().includes('install-smoke');
const receiptName=installed?'desktop-installed-native-smoke.json':'desktop-native-smoke.json';
const screenshotName=installed?'installed-operations.png':'native-operations.png';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function get(url){const response=await fetch(url,{signal:AbortSignal.timeout(1000)});return response.json();}
try{await get(`http://127.0.0.1:${port}/json/list`);throw new Error('QA debugging port is already occupied.');}catch(error){if(error.message==='QA debugging port is already occupied.')throw error;}
const child=spawn(exe,[],{cwd:path.dirname(exe),windowsHide:true,env:{...process.env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}`},stdio:['ignore','ignore','pipe']});
let startupError='';child.stderr.on('data',value=>{startupError=(startupError+value.toString()).slice(-6000);});
let exited=false;const exitPromise=new Promise(resolve=>child.once('exit',code=>{exited=true;resolve(code);}));
let socket;const pending=new Map();let sequence=0;let backendUrl;
try{
  let page;
  for(let attempt=0;attempt<120;attempt++){
    if(exited)throw new Error('Native application exited before WebView2 was ready. '+startupError);
    try{const pages=await get(`http://127.0.0.1:${port}/json/list`);page=pages.find(item=>item.type==='page'&&item.webSocketDebuggerUrl&&/tauri|localhost/.test(item.url));if(page)break;}catch{}
    await sleep(500);
  }
  assert(page,'Native WebView2 did not expose its temporary QA endpoint.');
  socket=new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  socket.addEventListener('message',event=>{const value=JSON.parse(event.data);const promise=pending.get(value.id);if(promise){pending.delete(value.id);value.error?promise.reject(new Error(value.error.message)):promise.resolve(value.result);}});
  const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));setTimeout(()=>{if(pending.delete(id))reject(new Error(`CDP request timed out: ${method}`));},15000).unref();});
  async function evaluate(expression){const value=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(value.exceptionDetails)throw new Error(value.exceptionDetails.text+': '+(value.exceptionDetails.exception?.description||''));return value.result?.value;}
  let view;
  for(let attempt=0;attempt<100;attempt++){view=await evaluate(`({title:document.title,url:location.href,link:document.body.innerText.includes('SIMULATION LINK ACTIVE'),header:document.querySelector('.wordmark')?.textContent,scripts:Array.from(document.scripts).map(script=>script.src),text:document.body.innerText.slice(0,1000),react:document.getElementById('root')?.childElementCount||0})`);if(view.link)break;await sleep(200);}
  assert(view.react>0&&view.link,'Bundled React UI did not establish its authenticated simulation link.');
  assert(view.header?.includes('GW-01')&&!/[\u00c2\u00c3\u00e2]/.test(view.header),'Native header still contains encoding damage.');
  await call('Emulation.setFocusEmulationEnabled',{enabled:true});
  await sleep(500);
  const stateExpression=`(async()=>{const info=await window.__TAURI_INTERNALS__.invoke('backend_info');const response=await fetch(info.base_url+'/api/state',{headers:{'X-Ghostwheel-Token':info.token}});if(!response.ok)throw new Error('Authenticated native API failed');const state=await response.json();return {base_url:info.base_url,tick:state.tick,steer_deg:state.vehicle.steer_deg,target_steer_deg:state.vehicle.target_steer_deg,throttle:state.vehicle.throttle,accepted:state.metrics.accepted,rejected:state.metrics.rejected,simulation_only:state.safety.actuation==='SIMULATOR_ONLY'};})()`;
  const before=await evaluate(stateExpression);backendUrl=before.base_url;assert(before.simulation_only);
  assert(await evaluate(`(()=>{const arm=document.querySelector('[aria-label="Arm simulated actuation"]');if(!arm||arm.disabled)return false;arm.click();document.body.tabIndex=-1;document.body.focus();return true;})()`),'Native arm control unavailable.');
  await sleep(200);
  await call('Input.dispatchKeyEvent',{type:'keyDown',key:'d',code:'KeyD',windowsVirtualKeyCode:68,nativeVirtualKeyCode:68});
  await sleep(1200);
  const steering=await evaluate(stateExpression);
  await call('Input.dispatchKeyEvent',{type:'keyUp',key:'d',code:'KeyD',windowsVirtualKeyCode:68,nativeVirtualKeyCode:68});
  const controlUi=await evaluate(`({armed:document.querySelector('[aria-label="Disarm simulated actuation"]')?.getAttribute('aria-pressed'),focus:document.hasFocus(),error:document.querySelector('.message.error')?.innerText})`);
  assert(steering.accepted>before.accepted&&steering.steer_deg>0.1,'Native UI steering did not actuate the simulated vehicle: '+JSON.stringify({before,steering,controlUi}));
  await evaluate(`document.querySelector('.safe-stop').click()`);await sleep(400);
  const stopped=await evaluate(stateExpression);assert(stopped.target_steer_deg===0&&stopped.throttle===0,'Native safe stop did not clear simulator targets.');
  const rejection=await evaluate(`(async()=>{const info=await window.__TAURI_INTERNALS__.invoke('backend_info');const response=await fetch(info.base_url+'/api/control',{method:'POST',headers:{'Content-Type':'application/json','X-Ghostwheel-Token':info.token},body:'{}'});return response.json();})()`);assert(rejection.accepted===false,'Native malformed control was not rejected.');
  const screenshot=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
  const screenshots=path.join(root,'output','screenshots');mkdirSync(screenshots,{recursive:true});writeFileSync(path.join(screenshots,screenshotName),Buffer.from(screenshot.data,'base64'));
  const verificationImages=path.join(root,'output','verification');mkdirSync(verificationImages,{recursive:true});writeFileSync(path.join(verificationImages,installed?'installed-console.png':'native-console.png'),Buffer.from(screenshot.data,'base64'));
  socket.close();socket=undefined;
  child.kill();await Promise.race([exitPromise,sleep(10000).then(()=>{throw new Error('Native host did not exit.');})]);
  let backendStopped=false;
  for(let i=0;i<30;i++){try{await get(backendUrl+'/api/health');}catch{backendStopped=true;break;}await sleep(100);}
  assert(backendStopped,'App-owned backend kept serving after native host exit.');
  const receipt={status:'passed',executable:path.relative(root,exe),executable_sha256:createHash('sha256').update(readFileSync(exe)).digest('hex'),view,checks:['native WebView2 launched','bundled React mounted','authenticated Tauri backend_info reached local service','native UI arming and keyboard steering accepted','native UI safe stop cleared targets','malformed command rejected through native webview','loopback service stopped after forced native host exit'],before,steering,stopped,rejection,backend_stopped:backendStopped,debugging:'Temporary test child environment only; CDP focus emulation keeps the hidden QA window focused. Release default has no remote-debugging flag',carla_server_exercised:false};
  const output=path.join(root,'output','verification');mkdirSync(output,{recursive:true});writeFileSync(path.join(output,receiptName),JSON.stringify(receipt,null,2));
  console.log(JSON.stringify({status:'passed',receipt:'output/verification/'+receiptName,screenshot:'output/screenshots/'+screenshotName},null,2));
}finally{socket?.close();if(!exited){child.kill();await Promise.race([exitPromise,sleep(10000)]);}}

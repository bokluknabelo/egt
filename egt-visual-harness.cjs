#!/usr/bin/env node
const http=require('http');
const fs=require('fs');
const path=require('path');
const {WebSocketServer}=require('ws');
const {EgtLocalSession}=require('./egt-local-engine.cjs');
const {patchGameBundle,patchReelsTimingBundle,mobileViewportScript}=require('./game-client-patches.cjs');

const gameKey=process.argv[2],targetRtp=Number(process.argv[3]||96),port=Number(process.argv[4]||18080),forceTrigger=process.argv.includes('--force-trigger'),forceEmptyHold=process.argv.includes('--force-empty-hold');
if(!gameKey)throw new Error('usage: node egt-visual-harness.cjs <gameKey> [targetRtp] [port] [--force-trigger]');
const profile=JSON.parse(fs.readFileSync(path.join(__dirname,'data','egt-profiles',`${gameKey}.json`),'utf8'));
const artifact=JSON.parse(fs.readFileSync(path.join(__dirname,'data','egt-math-configs',`${gameKey}.json`),'utf8')),record=artifact.configurations?.[targetRtp];
if(!record?.config||record.config.featureMathComplete!==true)throw new Error(`${gameKey}-${targetRtp} is not a complete-math candidate`);
const config=record.config,coinSet=new Set((config.roles.coins||[]).map(Number));
const triggerStops=forceTrigger?config.strips.map(strip=>{for(let stop=0;stop<strip.length;stop+=1)if(Array.from({length:config.rows},(_,row)=>strip[(stop+row)%strip.length]).some(symbol=>coinSet.has(Number(symbol))))return stop;throw new Error('trigger stop unavailable');}):[];
const randomInt=max=>triggerStops.length?triggerStops.shift():forceEmptyHold?max-1:require('crypto').randomInt(max);
const engine=new EgtLocalSession({profile,gameKey,balanceUnits:100000000,targetRtp,randomInt});engine.mathConfig=config;
const localSocketScript=`<script>(()=>{const Native=window.WebSocket;class LocalMathSocket extends Native{constructor(url,protocols){let destination=url;try{const parsed=new URL(String(url),location.href);if(parsed.hostname==='game-server-demo.egt-ong.com')destination=(location.protocol==='https:'?'wss:':'ws:')+'//'+location.host+'/egt-game-websocket'}catch{};protocols===undefined?super(destination):super(destination,protocols)}}Object.defineProperties(LocalMathSocket,{CONNECTING:{value:Native.CONNECTING},OPEN:{value:Native.OPEN},CLOSING:{value:Native.CLOSING},CLOSED:{value:Native.CLOSED}});window.WebSocket=LocalMathSocket;window.__EGT_VISUAL_MATH__=${JSON.stringify({gameKey,targetRtp,versionHash:config.versionHash,forceTrigger})}})();</script>`;

async function proxy(request,response,url){
  const relative=url.pathname.startsWith('/game-client/')?url.pathname.slice('/game-client/'.length):url.pathname.slice(1),search=new URLSearchParams(url.searchParams);search.delete('bridge');
  const target=new URL(relative+(search.size?`?${search}`:''),'https://games.egt-ong.com/');
  const upstream=await fetch(target,{headers:{accept:request.headers.accept||'*/*','accept-encoding':'identity','user-agent':request.headers['user-agent']||'Mozilla/5.0'},redirect:'follow'});
  if(!upstream.ok){response.writeHead(upstream.status,{'content-type':'text/plain'});return response.end(`upstream ${upstream.status}`);}
  let payload=Buffer.from(await upstream.arrayBuffer()),contentType=upstream.headers.get('content-type')||'application/octet-stream';
  if(/text\/html/i.test(contentType)){
    let html=payload.toString('utf8');html=html.replace('<head>','<head><base href="/game-client/">'+mobileViewportScript()+localSocketScript);payload=Buffer.from(html);
  }else if(/javascript/i.test(contentType)&&/(^|\/)index\.bundle\.min\.js$/.test(target.pathname))payload=Buffer.from(patchGameBundle(payload.toString('utf8'),{hidePlayLabels:false,currency:'GBP'}).source);
  else if(/javascript/i.test(contentType)&&/(^|\/)components\/reels\.chunk\.js$/.test(target.pathname))payload=Buffer.from(patchReelsTimingBundle(payload.toString('utf8')).source);
  response.writeHead(200,{'content-type':contentType,'content-length':payload.length,'cache-control':'no-store','access-control-allow-origin':'*'});response.end(payload);
}

const server=http.createServer(async(request,response)=>{try{const url=new URL(request.url,'http://localhost');if(url.pathname==='/health')return response.end(JSON.stringify({ok:true,gameKey,targetRtp,versionHash:config.versionHash}));await proxy(request,response,url);}catch(error){response.writeHead(500,{'content-type':'text/plain'});response.end(error.stack);}});
const sockets=new WebSocketServer({noServer:true});server.on('upgrade',(request,socket,head)=>{const url=new URL(request.url,'http://localhost');if(url.pathname!=='/egt-game-websocket')return socket.destroy();sockets.handleUpgrade(request,socket,head,client=>{client.send('o');client.on('message',data=>{try{for(const message of engine.messages(data))client.send(message);}catch(error){client.send(JSON.stringify({error:error.message}));}});});});
server.listen(port,'127.0.0.1',()=>process.stdout.write(JSON.stringify({ok:true,url:`http://127.0.0.1:${port}/game-client/?gameKey=${encodeURIComponent(gameKey)}`,gameKey,targetRtp,forceTrigger,forceEmptyHold})+'\n'));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>process.exit(0)));

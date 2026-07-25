const HOME_HANDLER = /onHomeClicked\(\)\{this\.view\.homeButton\.enabled[\s\S]*?\}onEGTLobbyClicked\(\)\{/g;

function mobileViewportScript() {
  return `<style data-egt-mobile-viewport>
:root{--egt-visual-width:100vw;--egt-visual-height:100dvh;--egt-safe-left:env(safe-area-inset-left,0px);--egt-safe-right:env(safe-area-inset-right,0px);--egt-safe-bottom:env(safe-area-inset-bottom,0px)}
html,body{box-sizing:border-box!important;margin:0!important;padding:0!important;width:var(--egt-visual-width)!important;height:var(--egt-visual-height)!important;min-height:0!important;max-height:var(--egt-visual-height)!important;overflow:hidden!important;overscroll-behavior:none!important;background:#000!important}
body,#app-root,#loading-overlay,#multitouchprotect{position:fixed!important;inset:0 auto auto 0!important;margin:0!important;width:var(--egt-visual-width)!important;height:var(--egt-visual-height)!important;min-height:0!important;max-height:var(--egt-visual-height)!important;overflow:hidden!important}
#app-canvas{position:absolute!important;top:0!important;bottom:auto!important;left:var(--egt-safe-left)!important;margin:0!important;width:calc(var(--egt-visual-width) - var(--egt-safe-left) - var(--egt-safe-right))!important;height:calc(var(--egt-visual-height) - var(--egt-safe-bottom))!important;max-width:none!important;max-height:none!important;touch-action:none!important}
#app-html,#modal-pop-up-layer{position:absolute!important;inset:0 var(--egt-safe-right) var(--egt-safe-bottom) var(--egt-safe-left)!important;overflow:hidden!important;pointer-events:none!important}
#app-html>* ,#modal-pop-up-layer>*{pointer-events:auto}
@supports not (height:100dvh){:root{--egt-visual-height:100vh}}
</style><script data-egt-mobile-viewport>(()=>{const root=document.documentElement,meta=document.querySelector('meta[name="viewport"]')||document.head.appendChild(Object.assign(document.createElement('meta'),{name:'viewport'}));meta.content='width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover,interactive-widget=resizes-content';let width=0,height=0,pending=false;const measure=()=>{pending=false;const viewport=window.visualViewport,nextWidth=Math.max(1,Math.round(viewport?.width||window.innerWidth||screen.width)),nextHeight=Math.max(1,Math.round(viewport?.height||window.innerHeight||screen.height));if(nextWidth===width&&nextHeight===height)return;width=nextWidth;height=nextHeight;root.style.setProperty('--egt-visual-width',width+'px');root.style.setProperty('--egt-visual-height',height+'px');window.__EGT_MOBILE_VIEWPORT__={width,height,updatedAt:Date.now()};requestAnimationFrame(()=>window.dispatchEvent(new Event('resize')))};const sync=()=>{if(pending)return;pending=true;requestAnimationFrame(measure)};addEventListener('resize',sync,{passive:true});addEventListener('orientationchange',()=>{sync();setTimeout(sync,150);setTimeout(sync,500)},{passive:true});addEventListener('pageshow',sync,{passive:true});document.addEventListener('fullscreenchange',sync,{passive:true});visualViewport?.addEventListener('resize',sync,{passive:true});visualViewport?.addEventListener('scroll',sync,{passive:true});sync();addEventListener('DOMContentLoaded',()=>{sync();setTimeout(sync,250);setTimeout(sync,1000)},{once:true})})();</script>`;
}

function localLobbyNavigationScript() {
  return `<script data-egt-local-lobby-navigation>(()=>{let leaving=false;const point=event=>event.changedTouches?.[0]||event.touches?.[0]||event;const footerExit=event=>{const canvas=document.querySelector('#app-canvas,canvas');if(!canvas)return false;const rect=canvas.getBoundingClientRect(),touch=point(event);if(!rect.width||!rect.height||!Number.isFinite(touch.clientX)||!Number.isFinite(touch.clientY))return false;const x=(touch.clientX-rect.left)/rect.width,y=(touch.clientY-rect.top)/rect.height,portrait=rect.height/rect.width>1.25;return y>=(portrait?.76:.9)&&(x<=.18||x>=.82)};const exit=event=>{if(leaving||!footerExit(event))return;leaving=true;event.preventDefault();event.stopPropagation();event.stopImmediatePropagation?.();window.top.location.assign('/')};addEventListener('pointerup',exit,true);addEventListener('touchend',exit,{capture:true,passive:false})})();</script>`;
}

function currencyWebSocketScript(currency = 'RON') {
  const selected = ['RON','EUR','GBP'].includes(currency) ? currency : 'RON';
  return `<script data-egt-currency-patch>(()=>{const selectedCurrency=${JSON.stringify(selected)},Native=window.WebSocket,wrapped=new WeakMap();function transform(data){if(typeof data!=='string')return data;const sockjs=data[0]==='a';try{const value=JSON.parse(sockjs?data.slice(1):data);const visit=(node,parent,key)=>{if(typeof node==='string'){if(node==='EGT'||node==='RON'||node==='EUR'||node==='GBP'){if(parent)parent[key]=selectedCurrency;return node!==selectedCurrency}try{const nested=JSON.parse(node);if(visit(nested,null,null)){if(parent)parent[key]=JSON.stringify(nested);return true}}catch{}return false}if(!node||typeof node!=='object')return false;let changed=false;for(const childKey of Object.keys(node))changed=visit(node[childKey],node,childKey)||changed;return changed};return visit(value,null,null)?(sockjs?'a':'')+JSON.stringify(value):data}catch{return data}}function eventFor(event){const changed=transform(event.data);return changed===event.data?event:new MessageEvent('message',{data:changed,origin:event.origin,lastEventId:event.lastEventId,source:event.source,ports:event.ports})}class CurrencyWebSocket extends Native{addEventListener(type,listener,options){if(type!=='message'||!listener)return super.addEventListener(type,listener,options);let fn=wrapped.get(listener);if(!fn){fn=event=>typeof listener==='function'?listener.call(this,eventFor(event)):listener.handleEvent(eventFor(event));wrapped.set(listener,fn)}return super.addEventListener(type,fn,options)}removeEventListener(type,listener,options){return super.removeEventListener(type,wrapped.get(listener)||listener,options)}set onmessage(listener){if(this.__currencyOnMessage)super.removeEventListener('message',this.__currencyOnMessage);this.__currencyOnMessage=listener?event=>listener.call(this,eventFor(event)):null;if(this.__currencyOnMessage)super.addEventListener('message',this.__currencyOnMessage)}get onmessage(){return this.__currencyOnMessage||null}}Object.defineProperties(CurrencyWebSocket,{CONNECTING:{value:Native.CONNECTING},OPEN:{value:Native.OPEN},CLOSING:{value:Native.CLOSING},CLOSED:{value:Native.CLOSED}});window.WebSocket=CurrencyWebSocket})();</script>`;
}

function patchGameBundle(source, options = {}) {
  let output = String(source);
  const playLabels = options.hidePlayLabels === false ? 0 : (output.match(/"PLAY"/g) || []).length;
  if (playLabels) output = output.replaceAll('"PLAY"', '""');
  const currency = ['RON','EUR','GBP'].includes(options.currency) ? options.currency : 'RON';
  const currencyLabels = (output.match(/"(?:EGT|RON|EUR|GBP)"/g) || []).length;
  if (currencyLabels) output = output.replace(/"(?:EGT|RON|EUR|GBP)"/g, `"${currency}"`);
  const homeHandlers = (output.match(HOME_HANDLER) || []).length;
  if (homeHandlers) output = output.replace(HOME_HANDLER, 'onHomeClicked(){window.top.location.href="/"}onEGTLobbyClicked(){');
  return { source: output, playLabels, currencyLabels, homeHandlers };
}

function patchReelsTimingBundle(source) {
  let output = String(source), replacements = 0;
  const timing = {
    gameInitialReelRotationTime: 70,
    gameInitialReelRotationTimeInQuickSpin: 45,
    gameBetweenReelsDelay: 25,
    gameBetweenReelsDelayInQuickSpin: 0,
    gameAnticipationReelsDelay: 120,
  };
  for (const [key, value] of Object.entries(timing)) {
    const pattern = new RegExp(`(${key}=)\\d+(?:\\.\\d+)?`, 'g');
    output = output.replace(pattern, (_match, prefix) => { replacements += 1; return `${prefix}${value}`; });
  }
  return { source: output, replacements };
}

module.exports = { patchGameBundle, patchReelsTimingBundle, currencyWebSocketScript, mobileViewportScript, localLobbyNavigationScript };

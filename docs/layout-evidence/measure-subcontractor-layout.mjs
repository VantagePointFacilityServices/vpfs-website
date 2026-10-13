import {spawn} from 'node:child_process';
const [w]=process.argv.slice(2);const port=9800+Math.floor(Math.random()*100);
const p=spawn(process.env.CHROME,['--headless=new','--no-sandbox','--disable-gpu',`--remote-debugging-port=${port}`,'about:blank'],{stdio:'ignore'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let t;for(let i=0;i<50;i++){try{t=await(await fetch(`http://127.0.0.1:${port}/json`)).json();if(t.length)break}catch{}await sleep(200)}
const ws=new WebSocket(t.find(x=>x.type==='page').webSocketDebuggerUrl);await new Promise(r=>ws.onopen=r);
let id=0;const pe={};ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pe[m.id]){pe[m.id](m.result)}};
const send=(a,b={})=>new Promise(r=>{const i=++id;pe[i]=r;ws.send(JSON.stringify({id:i,method:a,params:b}))});
await send('Emulation.setDeviceMetricsOverride',{width:+w,height:1000,deviceScaleFactor:1,mobile:+w<600});
await send('Page.navigate',{url:'http://127.0.0.1:8131/subcontractor.html'});await sleep(8000);
const r=await send('Runtime.evaluate',{returnByValue:true,expression:`JSON.stringify({sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth,grids:[...document.querySelectorAll('.card-grid-careers')].map(g=>({id:g.parentElement.id||g.id,cols:getComputedStyle(g).gridTemplateColumns.split(' ').length,h:[...g.children].map(c=>Math.round(c.getBoundingClientRect().height)),w:[...g.children].map(c=>Math.round(c.getBoundingClientRect().width))}))})`});
console.log(w,r.result.value);p.kill();ws.close();

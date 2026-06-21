import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
const kiro = join(homedir(),"AppData","Local","Kiro-Cli","kiro-cli.exe");
function run(label:string, fn:(send:(m:string,p:any)=>void, getSid:()=>string)=>void, waitMs=5000): Promise<void> {
  return new Promise((resolve)=>{
    const p = spawn(kiro,["acp","--trust-all-tools"],{stdio:["pipe","pipe","pipe"]});
    let buf=""; let id=0; const pend=new Map<number,string>(); let sid=""; let exited=false;
    const send=(method:string,params:any)=>{ const i=++id; pend.set(i,method); try{p.stdin.write(JSON.stringify({jsonrpc:"2.0",id:i,method,params})+"\n");}catch{} };
    p.on("exit",(c)=>{ exited=true; console.log(`  [${label}] PROCESS EXITED code=${c}`); });
    p.stdout.setEncoding("utf8");
    p.stdout.on("data",(c:string)=>{ buf+=c; let n; while((n=buf.indexOf("\n"))!==-1){ const line=buf.slice(0,n).trim(); buf=buf.slice(n+1); if(!line)continue; let m:any; try{m=JSON.parse(line)}catch{continue;}
      if(m.id!==undefined && pend.has(m.id) && m.method===undefined){ const meth=pend.get(m.id)!; pend.delete(m.id); if(meth==="session/new"){ sid=m.result.sessionId; fn(send,()=>sid); } else if(meth!=="initialize"){ console.log(`  [${label}] ${meth} =>`, JSON.stringify(m.result??{error:m.error}).slice(0,500)); } }
      else if(m.method && /model/i.test(JSON.stringify(m))){ console.log(`  [${label}] NOTIF ${m.method} =>`, JSON.stringify(m.params).slice(0,500)); }
    }});
    send("initialize",{protocolVersion:1,clientCapabilities:{fs:{readTextFile:true,writeTextFile:true},terminal:true},clientInfo:{name:"p",version:"1"}});
    setTimeout(()=>send("session/new",{cwd:process.cwd(),mcpServers:[]}),600);
    setTimeout(()=>{ if(!exited)p.kill(); resolve(); }, waitMs);
  });
}
await run("REAL", (send,getSid)=> send("session/set_model",{sessionId:getSid(),modelId:"claude-opus-4.8"}));
await run("INVALID", (send,getSid)=> send("session/set_model",{sessionId:getSid(),modelId:"nope-xyz-1"}));
await run("EXEC", (send,getSid)=> send("_kiro.dev/commands/execute",{sessionId:getSid(),command:"/model"}), 5000);
await run("OPTS", (send,getSid)=>{ send("_kiro.dev/commands/options",{sessionId:getSid(),commandName:"/model"}); send("_kiro.dev/commands/options",{sessionId:getSid(),name:"/model",arguments:""}); }, 5000);
process.exit(0);

import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';

// Run the production Caddyfile against local HTTP fixture upstreams. No TLS or cloud calls.
const name='alter-form-routing-'+randomUUID();
const docker=(args)=>execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:120000});
const start=`
set -eu
mkdir -p /srv/web
printf web > /srv/web/index.html
cat /etc/caddy/Caddyfile > /tmp/Caddyfile
cat >> /tmp/Caddyfile <<'FIXTURES'
http://127.0.0.1:8081 {
 respond "form"
}
http://127.0.0.1:8082 {
 respond "api"
}
http://127.0.0.1:8083 {
 respond "engine"
}
FIXTURES
exec caddy run --config /tmp/Caddyfile --adapter caddyfile
`;
try {
 docker(['run','-d','--entrypoint','sh','--name',name,'-p','127.0.0.1::80','--mount',`type=bind,src=${resolve('deploy/ec2/Caddyfile')},dst=/etc/caddy/Caddyfile,readonly`,
  '-e','ALTER_DOMAIN=http://:80','-e','PUBLIC_SURFACE_PORT=8081','-e','PLATFORM_API_PORT=8082','-e','ORCHESTRATION_PORT=8083','caddy:2.8-alpine','-c',start]);
 let port;
 for(let i=0;i<50;i++){
  port=JSON.parse(docker(['inspect',name]))[0].NetworkSettings.Ports?.['80/tcp']?.[0]?.HostPort;if(port)break;
  await new Promise(resolve=>setTimeout(resolve,100));
 }
 assert.ok(port,'Routing fixture requires an isolated published port');
 const base=`http://127.0.0.1:${port}`;let ready=false;
 for(let i=0;i<100;i++){
  try{ready=(await fetch(base,{signal:AbortSignal.timeout(1000)})).ok;if(ready)break;}catch{}
  await new Promise(resolve=>setTimeout(resolve,100));
 }
 assert.ok(ready,'Production Caddy routing fixture did not start');
 for(const [path,expected]of [['/f/native','form'],['/api/native','api'],['/v1/webhooks/ses','engine'],['/workflow/any','web'],['/health','web']]){
  const response=await fetch(base+path,{signal:AbortSignal.timeout(3000)});
  assert.equal(response.status,200,path+' routing status');assert.equal(await response.text(),expected,path+' upstream');
 }
 console.log('public-form-routing-passed');
}catch(error){try{console.error(docker(['logs',name]));}catch{}throw error;}finally{try{docker(['rm','-f',name]);}catch{}}

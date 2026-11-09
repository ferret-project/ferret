import ts from 'typescript-ast';import fs from 'node:fs';import path from 'node:path';
const root='node_modules/.pnpm';const messages={};
function scan(dir){if(!fs.existsSync(dir))return;for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())scan(p);else if(e.name==='error-codes.mjs'||e.name==='codes.mjs'){
 const source=fs.readFileSync(p,'utf8'),ast=ts.createSourceFile(p,source,99,true);
 function visit(n){if(ts.isCallExpression(n)&&n.expression.getText(ast)==='defineErrorCodes'&&n.arguments[0]&&ts.isObjectLiteralExpression(n.arguments[0]))for(const prop of n.arguments[0].properties)if(ts.isPropertyAssignment(prop)&&ts.isStringLiteral(prop.initializer))messages[prop.initializer.text]=prop.initializer.text;ts.forEachChild(n,visit)}visit(ast)
}}}
for(const name of fs.readdirSync(root))if(/^(?:better-auth@|@better-auth\+(?:core|passkey)@)/.test(name)){const base=path.join(root,name,'node_modules');for(const pkg of ['better-auth','@better-auth/core','@better-auth/passkey']){const dir=path.join(base,pkg,'dist');try{if(!fs.lstatSync(path.join(base,pkg)).isSymbolicLink())scan(dir)}catch{}}}
fs.writeFileSync('packages/shared/src/locales/auth-messages.json',JSON.stringify(messages,null,2)+'\n');console.log(Object.keys(messages).length,'Better Auth 1.7.14 source errors');
const en=JSON.parse(fs.readFileSync('packages/shared/src/locales/en.json','utf8'));Object.assign(en,messages);fs.writeFileSync('packages/shared/src/locales/en.json',JSON.stringify(en,null,2)+'\n');

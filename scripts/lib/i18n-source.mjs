import ts from 'typescript-ast';
import fs from 'node:fs';
import path from 'node:path';

export function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? sourceFiles(path.join(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [path.join(dir, entry.name)] : []);
}
export const copyAttributes = new Set(['title','subtitle','label','placeholder','aria-label','alt','description','help','emptyText','confirmLabel','submitLabel','noneLabel','submit','cancelLabel','heading','message','note','detail','summary','text','body','empty','legend','hint']);
const technicalAttributes = new Set(['className','id','name','type','value','defaultValue','key','href','src','to','role','aria-current','aria-live','autoComplete','pattern','accept','method','target','rel','section','page','icon','feature','kind','status','direction','unit','where','format','currency','language']);
const translated = new Set(['t','tr','translateText','translate','message']);
const ancestor = (n, pred) => { for (let p=n.parent; p; p=p.parent) if(pred(p)) return p; };
const human = (raw) => { const s=raw.replace(/\{v\d+\}/g,''); return /[A-Za-z]/.test(s) && !/^(?:https?:|\/|#|icon-|[\w.-]+\.(?:ts|tsx|js|jpg|png|webp|pdf|csv|json)|[A-Z_][A-Z0-9_]{2,}$)/.test(s); };

/** Conservative inventory: strong display contexts are actionable; other natural-language literals need review. */
export function inspectSource(file) {
 const source=fs.readFileSync(file,'utf8');
 const ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,file.endsWith('.tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS);
 const entries=[];
 function visit(node) {
  const p=node.parent;
  if(ts.isJsxText(node)) {
   if(human(node.text.trim())) entries.push({ node, kind:'jsx', text:node.text.trim(), actionable:true });
  } else if(ts.isStringLiteral(node)||ts.isNoSubstitutionTemplateLiteral(node)||ts.isTemplateExpression(node)) {
   const text=ts.isTemplateExpression(node)?node.head.text+node.templateSpans.map((s,i)=>`{v${i}}`+s.literal.text).join(''):node.text;
   if(!human(text)){ts.forEachChild(node,visit);return;}
   if(ancestor(node,n=>ts.isTypeNode(n)||ts.isImportDeclaration(n)||ts.isExportDeclaration(n)))return;
   if(ts.isPropertyAssignment(p)&&p.name===node||ts.isElementAccessExpression(p)&&p.argumentExpression===node)return;
   if(ancestor(node,n=>ts.isTaggedTemplateExpression(n)))return;
   if(ts.isCallExpression(p)&&translated.has(p.expression.getText(ast))&&p.arguments[0]===node)return;
   if(ts.isCallExpression(p)&&['tn','trn'].includes(p.expression.getText(ast))&&[p.arguments[1],p.arguments[2]].includes(node))return;
   if(ts.isBinaryExpression(p)&&![ts.SyntaxKind.QuestionQuestionToken,ts.SyntaxKind.BarBarToken,ts.SyntaxKind.PlusToken,ts.SyntaxKind.AmpersandAmpersandToken].includes(p.operatorToken.kind))return;
   let attr = null;
   for(let parent=node.parent;parent;parent=parent.parent) { if(ts.isJsxElement(parent)) break; if(ts.isJsxAttribute(parent)){attr=parent;break;} }
   if(attr&&!copyAttributes.has(attr.name.getText(ast)))return;
   if(ts.isCallExpression(p)&&/^(?:describe|includes|startsWith|endsWith|test|match|replace|split|join|set|get|append|on|use|route|post|put|patch|options|fetch|request|enum|literal|default|eq|ne|index|text|integer|sqliteTable)$/.test(p.expression.getText(ast).split('.').at(-1)))return;
   const property=ts.isPropertyAssignment(p)?p.name.getText(ast):null;
   if(property&&!copyAttributes.has(property)&&!/^v\d+$/.test(property))return;
   let rendered = false;
   for (let parent=node.parent; parent; parent=parent.parent) { if(ts.isFunctionLike(parent)) break; if(ts.isJsxExpression(parent)) { rendered=true; break; } }
   const error=ancestor(node,n=>ts.isNewExpression(n)&&/Error/.test(n.expression.getText(ast)));
   const insideTemplate=ancestor(node,n=>ts.isTemplateExpression(n)||ts.isPropertyAssignment(n)&&/^v\d+$/.test(n.name.getText(ast)));
   const actionable=Boolean(attr&&copyAttributes.has(attr.name.getText(ast))||rendered||error||property&&copyAttributes.has(property)||insideTemplate);
   if(actionable||ts.isTemplateExpression(node)||/[a-z][ ,:;!?…—'’]/i.test(text)||/^[A-Z][a-z]+(?: [A-Za-z]+)*$/.test(text))entries.push({node,kind:actionable?'copy':'review',text,actionable});
  }
  ts.forEachChild(node,visit);
 }
 visit(ast);
 return {source,ast,entries:entries.map(e=>({...e,line:ast.getLineAndCharacterOfPosition(e.node.getStart(ast)).line+1}))};
}

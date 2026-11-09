const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),path=require('node:path');
const exportsObject={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/lib/return-path.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:exportsObject});
const {safeReturnPath}=exportsObject;const id='1b62b150-e862-40ff-a25b-f1184ed6e000';
test('list, title, social and invitation links retain their exact typed target',()=>{
 for(const value of [`/list/${id}`,'/lists/abc_123-AabbxYYzz','/titles/tv/1399',`/titles/movie/${id}`,`/post/${id}`,`/profile/${id}`,'/teams/join?code=my_code'])assert.equal(safeReturnPath(value),value);
});
test('external, malformed and unsupported redirects are rejected',()=>{
 for(const value of ['//evil.example','https://evil.example','/titles/tv/123bad','/titles/unknown/12','/lists/abc%2Fdefghijklmnop','/teams/join?code=xx&redirect=bad','/profile/a/../b','/sign-in','/list/'+id+'?token=secret',null])assert.equal(safeReturnPath(value),null);
});


// The original unit tests use disconnected Mongoose models as doubles. Load
// the integrated source bodies with that test connection; HTTP tests exercise
// the authenticated model adapter against a real isolated replica set.
const fs = require("node:fs"), path = require("node:path"), {createRequire} = require("node:module");
const root = path.resolve(__dirname,"../../src/tools/inventory-admin/original/src");
const cache = new Map();
function load(name) {
  const filename=path.resolve(root,name.endsWith(".js")?name:name+".js");
  if(!filename.startsWith(root+path.sep))throw new Error("Unexpected inventory test import.");
  if(cache.has(filename))return cache.get(filename).exports;
  const module={exports:{}};cache.set(filename,module);
  const native=createRequire(filename);
  const source=fs.readFileSync(filename,"utf8").replaceAll("../../../mongoose-context.cjs","mongoose");
  const request=name=>name.startsWith(".")?load(path.relative(root,path.resolve(path.dirname(filename),name))):native(name);
  new Function("require","module","exports","__filename","__dirname",source)(request,module,module.exports,filename,path.dirname(filename));
  return module.exports;
}
module.exports={load};

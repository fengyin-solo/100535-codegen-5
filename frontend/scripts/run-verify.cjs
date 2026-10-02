// 把 @ 别名指到编译产物上，再跑规则验证。
const Module = require('module')
const path = require('path')
const outSrc = path.join(__dirname, '..', 'node_modules', '.cache', 'verify', 'src')
const orig = Module._resolveFilename
Module._resolveFilename = function (request, ...args) {
  if (request.startsWith('@/')) {
    request = path.join(outSrc, request.slice(2))
  }
  return orig.call(this, request, ...args)
}
require(path.join(__dirname, '..', 'node_modules', '.cache', 'verify', 'scripts', 'verify-expense.js'))

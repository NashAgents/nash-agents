import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const compiler = process.env.CC ?? "cc";
const available = spawnSync(compiler,["--version"],{stdio:"ignore"}).status === 0;
test("REAL_NATIVE: config parser respects top-level keys, numeric versions, Unicode and control escapes",{skip:!available},async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),"nash-json-parser-"));t.after(()=>rm(dir,{recursive:true,force:true}));
  const source=path.join(dir,"fixture.c"),binary=path.join(dir,"fixture");
  await writeFile(source,`#include <stdio.h>\n#include <stdlib.h>\n#include <string.h>\n#include <errno.h>\n#ifdef _WIN32\n#include <fcntl.h>\n#include <io.h>\n#endif\n#include "json-config.h"\nint main(int argc, char **argv) {\n#ifdef _WIN32\n if(_setmode(_fileno(stdout), _O_BINARY) == -1) return 4;\n#endif\n if(argc!=2) return 1;\n const char *end=json_value_end(argv[1],0);\n if(!end||*json_ws(end)) return 2;\n int version=extract_json_int_field(argv[1],"protocolVersion",-1);\n char *command=extract_json_string_field(argv[1],"command");\n char **args=NULL; int count=0; extract_json_string_array(argv[1],"args",&args,&count);\n int flag=extract_json_bool_field(argv[1],"landlockEnabled",0);\n if(json_config_error||version!=1||!command) return 3;\n printf("%d\\n%s\\n",flag,command);free(command);\n for(int i=0;i<count;i++){fputs(args[i],stdout);free(args[i]);}free(args);return 0;\n}\n`);
  execFileSync(compiler,["-std=c11","-Wall","-Wextra","-Werror","-I",path.resolve("native/linux-sandbox-helper"),source,"-o",binary]);
  const json='{"nested":{"command":"wrong","landlockEnabled":false},"protocolVersion":1,"command":"printf","args":["\\u4e2d\\u6587\\r\\n\\uD83D\\uDE00"],"landlockEnabled":true}';
  assert.equal(execFileSync(binary,[json],{encoding:"utf8"}),"1\nprintf\n中文\r\n😀");
  for(const invalid of [json.replace('"protocolVersion":1','"protocolVersion":9'),json.replace('"protocolVersion":1','"protocolVersion":"1"'),json.replace('"command":"printf"','"command":"a","command":"b"'),json.replace('\\u4e2d','\\u0000'),json+' trailing']) assert.notEqual(spawnSync(binary,[invalid]).status,0);
});

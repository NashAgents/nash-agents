import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  ToolExecutor,
  createDefaultToolRegistry,
  resolveWorkspacePath,
} from "../src/tools/index.js";

async function runAllTests() {
  console.log("=== 文件系统工具与路径安全完整测试套件 ===\n");

  const registry = createDefaultToolRegistry();
  const executor = new ToolExecutor(registry);

  const testDir = path.resolve(process.cwd(), "test_temp_sandbox");

  // 清理并准备测试环境
  await fs.rm(testDir, { recursive: true, force: true });
  await fs.mkdir(testDir, { recursive: true });

  try {
    // ----------------------------------------------------
    // 1. 路径安全测试
    // ----------------------------------------------------
    console.log("--- 1. 路径安全测试 ---");

    // 1.1 正常项目内相对路径
    const safeRel = resolveWorkspacePath("src/index.ts");
    assert.equal(safeRel, path.resolve(process.cwd(), "src/index.ts"));

    // 1.2 正常项目内绝对路径
    const safeAbs = resolveWorkspacePath(path.resolve(process.cwd(), "package.json"));
    assert.equal(safeAbs, path.resolve(process.cwd(), "package.json"));

    // 1.3 `../` 越权
    assert.throws(
      () => resolveWorkspacePath("../outside-project.txt"),
      /安全限制：拒绝访问工作区根目录之外的路径/
    );

    // 1.4 多层 `../` 越权
    assert.throws(
      () => resolveWorkspacePath("../../etc/passwd"),
      /安全限制：拒绝访问工作区根目录之外的路径/
    );

    // 1.5 工作区外绝对路径
    assert.throws(
      () => resolveWorkspacePath("/etc/passwd"),
      /安全限制：拒绝访问工作区根目录之外的路径/
    );

    // 1.6 根目录自身解析 (空字符串或 ".")
    assert.equal(resolveWorkspacePath(""), path.resolve(process.cwd()));
    assert.equal(resolveWorkspacePath("."), path.resolve(process.cwd()));

    console.log("✓ 1. 路径安全检查（正常相对、合法绝对、../越权、多层越权、外部绝对路径）全部通过");

    // ----------------------------------------------------
    // 2. write_file 测试
    // ----------------------------------------------------
    console.log("\n--- 2. write_file 测试 ---");

    const relFilePath = "test_temp_sandbox/nested/dir/hello.txt";

    // 2.1 创建文件并自动创建深层父目录
    const writeResult1 = await executor.execute("write_file", {
      path: relFilePath,
      content: "Line 1: Hello World\nLine 2: Test Write\n",
    });
    assert.equal(writeResult1.success, true);
    assert.match(writeResult1.output, /成功写入文件/);
    const contentOnDisk1 = await fs.readFile(
      path.resolve(process.cwd(), relFilePath),
      "utf-8"
    );
    assert.equal(contentOnDisk1, "Line 1: Hello World\nLine 2: Test Write\n");

    // 2.2 覆盖文件
    const writeResult2 = await executor.execute("write_file", {
      path: relFilePath,
      content: "Overwritten content here.\n",
    });
    assert.equal(writeResult2.success, true);
    const contentOnDisk2 = await fs.readFile(
      path.resolve(process.cwd(), relFilePath),
      "utf-8"
    );
    assert.equal(contentOnDisk2, "Overwritten content here.\n");

    // 2.3 写入目标已存在且是目录时报错
    const writeDirResult = await executor.execute("write_file", {
      path: "test_temp_sandbox/nested",
      content: "cannot overwrite dir",
    });
    assert.equal(writeDirResult.success, false);
    assert.match(writeDirResult.output, /目标路径已存在且为一个目录/);

    console.log("✓ 2. write_file 创建文件、自动递归创建父目录、覆盖文件、目录冲突拦截通过");

    // ----------------------------------------------------
    // 3. read_file 测试 (分段读取机制)
    // ----------------------------------------------------
    console.log("\n--- 3. read_file 测试 ---");

    // 准备多行测试文件 (300 行)
    const longFilePath = "test_temp_sandbox/long_file.txt";
    const longLines: string[] = [];
    for (let i = 1; i <= 300; i++) {
      longLines.push(`Line content for line ${i}`);
    }
    await fs.writeFile(
      path.resolve(process.cwd(), longFilePath),
      longLines.join("\n") + "\n",
      "utf-8"
    );

    // 3.1 默认读取前 N 行 (默认 offset=1, limit=200)
    const readDefaultResult = await executor.execute("read_file", {
      path: longFilePath,
    });
    assert.equal(readDefaultResult.success, true);
    assert.match(readDefaultResult.output, /Lines 1-200 of 300/);
    assert.match(readDefaultResult.output, /1: Line content for line 1/);
    assert.match(readDefaultResult.output, /200: Line content for line 200/);
    assert.match(
      readDefaultResult.output,
      /More lines available\. Continue from offset=201, charOffset=0\./
    );

    // 3.2 自定义 offset + limit
    const readSegmentResult = await executor.execute("read_file", {
      path: longFilePath,
      offset: 250,
      limit: 71,
    });
    assert.equal(readSegmentResult.success, true);
    assert.match(readSegmentResult.output, /Lines 250-300 of 300/);
    assert.match(readSegmentResult.output, /250: Line content for line 250/);
    assert.match(readSegmentResult.output, /300: Line content for line 300/);
    assert.match(readSegmentResult.output, /\(End of file - all lines read\)/);

    // 3.3 行号正确性验证
    const smallFilePath = "test_temp_sandbox/small.txt";
    await fs.writeFile(
      path.resolve(process.cwd(), smallFilePath),
      "Apple\nBanana\nCherry\n",
      "utf-8"
    );
    const readSmallResult = await executor.execute("read_file", {
      path: smallFilePath,
      offset: 2,
      limit: 1,
    });
    assert.equal(readSmallResult.success, true);
    assert.match(readSmallResult.output, /Lines 2-2 of 3/);
    assert.match(readSmallResult.output, /2: Banana/);
    assert.match(
      readSmallResult.output,
      /More lines available\. Continue from offset=3, charOffset=0\./
    );

    // 3.4 offset 超出文件总行数
    const readOverflow = await executor.execute("read_file", {
      path: smallFilePath,
      offset: 10,
    });
    assert.equal(readOverflow.success, true);
    assert.match(readOverflow.output, /超出了文件总行数 \(共 3 行\)/);

    // 3.5 空文件读取
    const emptyFilePath = "test_temp_sandbox/empty.txt";
    await fs.writeFile(path.resolve(process.cwd(), emptyFilePath), "", "utf-8");
    const readEmpty = await executor.execute("read_file", {
      path: emptyFilePath,
    });
    assert.equal(readEmpty.success, true);
    assert.match(readEmpty.output, /文件为空 \(总行数: 0\)/);

    // 3.6 文件不存在返回明确错误
    const readNotExist = await executor.execute("read_file", {
      path: "test_temp_sandbox/non_existent.txt",
    });
    assert.equal(readNotExist.success, false);
    assert.match(readNotExist.output, /文件不存在/);

    // 3.7 path 是目录时返回明确错误
    const readDir = await executor.execute("read_file", {
      path: "test_temp_sandbox/nested",
    });
    assert.equal(readDir.success, false);
    assert.match(readDir.output, /目标路径是一个目录，无法作为文件读取/);

    console.log(
      "✓ 3. read_file 默认前200行、offset+limit正确、行号标注、总行数、后续提示、超界处理、空文件、不存在报错、目录报错通过"
    );

    // ----------------------------------------------------
    // 4. edit_file 测试 (确定性单次替换)
    // ----------------------------------------------------
    console.log("\n--- 4. edit_file 测试 ---");

    const editTargetRel = "test_temp_sandbox/edit_target.txt";
    await fs.writeFile(
      path.resolve(process.cwd(), editTargetRel),
      "alpha\nbeta foo\ngamma\nbeta foo\n",
      "utf-8"
    );

    // 4.1 old_text 出现 0 次报错
    const editZero = await executor.execute("edit_file", {
      path: editTargetRel,
      old_text: "not_found_string",
      new_text: "something",
    });
    assert.equal(editZero.success, false);
    assert.match(editZero.output, /未找到待替换的 'old_text'/);

    // 4.2 old_text 出现 >1 次报错
    const editMultiple = await executor.execute("edit_file", {
      path: editTargetRel,
      old_text: "beta foo",
      new_text: "beta bar",
    });
    assert.equal(editMultiple.success, false);
    assert.match(editMultiple.output, /出现了 2 次/);

    // 4.3 恰好出现 1 次成功替换
    const editOnce = await executor.execute("edit_file", {
      path: editTargetRel,
      old_text: "alpha\nbeta foo",
      new_text: "alpha\nbeta replaced",
    });
    assert.equal(editOnce.success, true);
    assert.match(editOnce.output, /成功修改文件/);

    const editedContent = await fs.readFile(
      path.resolve(process.cwd(), editTargetRel),
      "utf-8"
    );
    assert.equal(
      editedContent,
      "alpha\nbeta replaced\ngamma\nbeta foo\n"
    );

    console.log("✓ 4. edit_file 0次未匹配报错、多于1次出现保护拦截、恰好1次确定性替换通过");

    // ----------------------------------------------------
    // 5. list_files 测试 (非递归直接子项 & 稳定排序)
    // ----------------------------------------------------
    console.log("\n--- 5. list_files 测试 ---");

    // 5.1 正常列出目录 (返回 [ { name, type } ])
    const listResult = await executor.execute("list_files", {
      path: "test_temp_sandbox",
    });
    assert.equal(listResult.success, true);
    const parsedList = JSON.parse(listResult.output);
    assert.ok(Array.isArray(parsedList));

    // 检查字段结构
    for (const item of parsedList) {
      assert.ok(typeof item.name === "string");
      assert.ok(["file", "directory", "other"].includes(item.type));
    }

    // 检查稳定排序 (按 name 升序)
    const sortedNames = [...parsedList.map((i: any) => i.name)].sort((a, b) =>
      a.localeCompare(b)
    );
    const actualNames = parsedList.map((i: any) => i.name);
    assert.deepEqual(actualNames, sortedNames);

    // 5.2 目录不存在报错
    const listNotExist = await executor.execute("list_files", {
      path: "test_temp_sandbox/not_exist_folder",
    });
    assert.equal(listNotExist.success, false);
    assert.match(listNotExist.output, /目录不存在/);

    // 5.3 path 是普通文件报错
    const listFileResult = await executor.execute("list_files", {
      path: editTargetRel,
    });
    assert.equal(listFileResult.success, false);
    assert.match(listFileResult.output, /目标路径不是目录/);

    console.log("✓ 5. list_files 非递归直接子项、稳定排序、不存在报错、文件路径拦截通过");

    // ----------------------------------------------------
    // 6. grep_search 测试 (ripgrep 高性能搜索)
    // ----------------------------------------------------
    console.log("\n--- 6. grep_search 测试 ---");

    // 准备搜索文件目录
    const grepDir = path.resolve(testDir, "grep_test_dir");
    await fs.mkdir(grepDir, { recursive: true });

    await fs.writeFile(
      path.resolve(grepDir, "file1.ts"),
      "export const targetToken = 'hello';\nconst unimportant = 1;\nconsole.log(targetToken);\n",
      "utf-8"
    );
    await fs.writeFile(
      path.resolve(grepDir, "file2.ts"),
      "// some comment\nexport function useToken() {\n  return targetToken;\n}\n",
      "utf-8"
    );

    // 6.1 普通字符串搜索、多文件搜索、行号与 path:line:content 格式
    const grepRes = await executor.execute("grep_search", {
      query: "targetToken",
      path: "test_temp_sandbox/grep_test_dir",
    });
    assert.equal(grepRes.success, true);
    assert.match(
      grepRes.output,
      /test_temp_sandbox\/grep_test_dir\/file1\.ts:1:export const targetToken = 'hello';/
    );
    assert.match(
      grepRes.output,
      /test_temp_sandbox\/grep_test_dir\/file1\.ts:3:console\.log\(targetToken\);/
    );
    assert.match(
      grepRes.output,
      /test_temp_sandbox\/grep_test_dir\/file2\.ts:3:  return targetToken;/
    );

    // 6.2 忽略目录 (node_modules, dist, .git)
    const subNodeModules = path.resolve(grepDir, "node_modules");
    await fs.mkdir(subNodeModules, { recursive: true });
    await fs.writeFile(
      path.resolve(subNodeModules, "ignored.ts"),
      "export const targetToken = 'should_be_ignored';",
      "utf-8"
    );

    const grepIgnoreRes = await executor.execute("grep_search", {
      query: "targetToken",
      path: "test_temp_sandbox/grep_test_dir",
    });
    assert.equal(grepIgnoreRes.success, true);
    assert.equal(grepIgnoreRes.output.includes("should_be_ignored"), false);
    assert.equal(grepIgnoreRes.output.includes("ignored.ts"), false);

    // 6.3 最大结果限制截断
    const manyMatchesFile = path.resolve(grepDir, "many_matches.txt");
    const manyLines: string[] = [];
    for (let i = 0; i < 150; i++) {
      manyLines.push(`repeatToken line ${i}`);
    }
    await fs.writeFile(manyMatchesFile, manyLines.join("\n"), "utf-8");

    const grepLimitRes = await executor.execute("grep_search", {
      query: "repeatToken",
      path: "test_temp_sandbox/grep_test_dir",
    });
    assert.equal(grepLimitRes.success, true);
    assert.match(grepLimitRes.output, /已达到最大匹配数量限制 \(100 条\)/);

    // 6.4 空 PATH 下可使用已发现的内置 rg，否则必须给出明确的缺失错误。
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = "";
      const missingRgRes = await executor.execute("grep_search", {
        query: "targetToken",
        path: "test_temp_sandbox/grep_test_dir",
      });
      if (missingRgRes.success) assert.match(missingRgRes.output, /file1\.ts:1:export const targetToken/);
      else assert.match(missingRgRes.output, /ripgrep \(rg\) is not installed or not available in PATH/);
    } finally {
      process.env.PATH = originalPath;
    }

    console.log(
      "✓ 6. grep_search ripgrep调用、多文件匹配、path:line:content格式、行号正确、node_modules忽略、最大数量限制、rg缺失明确报错通过"
    );

    // ----------------------------------------------------
    // 7. 工具执行器的越权拦截保护
    // ----------------------------------------------------
    console.log("\n--- 7. ToolExecutor 越界统一保护 ---");

    const outOfRootRead = await executor.execute("read_file", {
      path: "../../package.json",
    });
    assert.equal(outOfRootRead.success, false);
    assert.match(outOfRootRead.output, /安全限制：拒绝访问工作区根目录之外的路径/);

    const outOfRootWrite = await executor.execute("write_file", {
      path: "/tmp/evil.txt",
      content: "forbidden",
    });
    assert.equal(outOfRootWrite.success, false);
    assert.match(outOfRootWrite.output, /安全限制：拒绝访问工作区根目录之外的路径/);

    const outOfRootEdit = await executor.execute("edit_file", {
      path: "/etc/hosts",
      old_text: "a",
      new_text: "b",
    });
    assert.equal(outOfRootEdit.success, false);
    assert.match(outOfRootEdit.output, /安全限制：拒绝访问工作区根目录之外的路径/);

    const outOfRootList = await executor.execute("list_files", {
      path: "../..",
    });
    assert.equal(outOfRootList.success, false);
    assert.match(outOfRootList.output, /安全限制：拒绝访问工作区根目录之外的路径/);

    const outOfRootGrep = await executor.execute("grep_search", {
      query: "test",
      path: "/var/log",
    });
    assert.equal(outOfRootGrep.success, false);
    assert.match(outOfRootGrep.output, /安全限制：拒绝访问工作区根目录之外的路径/);

    console.log("✓ 7. 5个文件工具的越权路径访问统一被 ToolExecutor 安全拦截");

    console.log("\n==================================================");
    console.log("🎉 所有新增文件系统工具及路径安全测试 100% 成功通过！");
    console.log("==================================================\n");
  } finally {
    // 清理沙箱目录
    await fs.rm(testDir, { recursive: true, force: true });
  }
}

runAllTests().catch((err) => {
  console.error("测试未通过:", err);
  process.exit(1);
});

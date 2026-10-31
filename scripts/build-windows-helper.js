import fs from "node:fs";
import path from "node:path";
import cp from "node:child_process";
import crypto from "node:crypto";

export function buildWindowsHelper() {
  if (process.platform !== "win32") {
    console.log("Not on Windows, skipping Windows helper compilation.");
    return false;
  }

  const rootDir = process.cwd();
  const sourceFile = path.resolve(rootDir, "native/windows-sandbox-helper/main.c");
  const outDir = path.resolve(rootDir, "native/bin/win32-x64");
  const outFile = path.resolve(outDir, "nash-windows-sandbox-helper.exe");

  if (!fs.existsSync(sourceFile)) {
    console.error(`Source file not found: ${sourceFile}`);
    return false;
  }

  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  // 寻找 vcvars64.bat
  const vsCandidates = [
    "C:/Program Files (x86)/Microsoft Visual Studio/2019/Community/VC/Auxiliary/Build/vcvars64.bat",
    "C:/Program Files/Microsoft Visual Studio/2022/Community/VC/Auxiliary/Build/vcvars64.bat",
    "C:/Program Files/Microsoft Visual Studio/2022/Enterprise/VC/Auxiliary/Build/vcvars64.bat",
    "C:/Program Files/Microsoft Visual Studio/2022/Professional/VC/Auxiliary/Build/vcvars64.bat",
    "C:/Program Files (x86)/Microsoft Visual Studio/2019/Enterprise/VC/Auxiliary/Build/vcvars64.bat",
    "C:/Program Files (x86)/Microsoft Visual Studio/2019/Professional/VC/Auxiliary/Build/vcvars64.bat",
    "C:/Program Files (x86)/Microsoft Visual Studio/2019/BuildTools/VC/Auxiliary/Build/vcvars64.bat",
  ];

  let vcvarsBat = vsCandidates.find((c) => fs.existsSync(c));

  if (!vcvarsBat) {
    try {
      const vswhere = "C:/Program Files (x86)/Microsoft Visual Studio/Installer/vswhere.exe";
      if (fs.existsSync(vswhere)) {
        const installPath = cp
          .execFileSync(vswhere, ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"], { encoding: "utf-8" })
          .trim();
        const candidate = path.join(installPath, "VC/Auxiliary/Build/vcvars64.bat");
        if (fs.existsSync(candidate)) {
          vcvarsBat = candidate;
        }
      }
    } catch {}
  }

  if (!vcvarsBat) {
    console.error("Could not find vcvars64.bat for Visual Studio MSVC compiler.");
    return false;
  }

  const installerDir = "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer";
  const cmd = `set "PATH=${installerDir};%PATH%" && call "${vcvarsBat.replace(/\//g, "\\")}" >nul && cl /nologo /utf-8 /O2 /Brepro /Fe:"${outFile.replace(/\//g, "\\")}" "${sourceFile.replace(/\//g, "\\")}" userenv.lib advapi32.lib user32.lib >nul`;

  try {
    cp.execSync(cmd, { shell: "cmd.exe", stdio: "inherit" });
    // 清理生成的 .obj 文件
    const objFile = outFile.replace(/\.exe$/, ".obj");
    if (fs.existsSync(objFile)) {
      fs.unlinkSync(objFile);
    }
    const rootObj = path.resolve(rootDir, "main.obj");
    if (fs.existsSync(rootObj)) {
      fs.unlinkSync(rootObj);
    }

    if (fs.existsSync(outFile)) {
      console.log(`Successfully compiled: ${outFile}`);
      const checkOut = cp.execFileSync(outFile, ["--version-json"], { encoding: "utf-8" });
      console.log(`Version verification: ${checkOut.trim()}`);
      const toolchain = cp.execSync(`call "${vcvarsBat}" >nul && set VCToolsVersion && set WindowsSDKVersion`, { shell: "cmd.exe", encoding: "utf8" }).trim();
      const digest = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
      let sourceCommit = "0.1.0";
      try {
        sourceCommit = cp.execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      } catch {
        try {
          const buildInfo = JSON.parse(fs.readFileSync(path.resolve(rootDir, "dist/build-info.json"), "utf8"));
          sourceCommit = buildInfo.commit ?? "0.1.0";
        } catch {}
      }
      const manifest = {
        schemaVersion: 1,
        sourceCommit,
        sourceSha256: digest(sourceFile),
        binarySha256: digest(outFile),
        protocolVersion: JSON.parse(checkOut).protocolVersion,
        platform: process.platform, arch: process.arch, toolchain,
        configuration: "MSVC /O2 /utf-8 /Brepro",
        executable: path.relative(rootDir, outFile).replaceAll("\\", "/"),
        builtAt: new Date().toISOString(),
        verification: "BUILT_PROTOCOL_CHECKED_ISOLATION_UNVERIFIED",
      };
      fs.writeFileSync(`${outFile}.manifest.json`, JSON.stringify(manifest, null, 2) + "\n");
      console.log(`Native artifact SHA256: ${manifest.binarySha256}`);
      return true;
    }
  } catch (err) {
    console.error("Failed to build Windows sandbox helper:", err);
    return false;
  }

  return false;
}

if (process.argv[1] && process.argv[1].endsWith("build-windows-helper.js")) {
  const success = buildWindowsHelper();
  process.exit(success ? 0 : 1);
}

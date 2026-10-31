/**
 * Nash Agent — Native Windows Sandbox Helper (nash-windows-sandbox-helper)
 *
 * 核心安全职责：
 * 1. Windows Job Objects 强隔离与全进程树生命周期控制：
 *    - 强制 JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE 与 JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION
 *    - 进程以挂起模式 (CREATE_SUSPENDED) 启动，100% 确保在执行任何外部代码前加入 Job Object
 *    - 禁止子进程通过 Breakaway 逃逸
 *    - 超时或取消时通过 TerminateJobObject 彻底销毁整个进程树，杜绝孤儿进程泄漏
 * 2. Windows Restricted Token 与 Integrity Levels 权限收缩：
 *    - DISABLE_MAX_PRIVILEGE 剥离管理员特权
 *    - 支持降低为 Medium / Low Integrity Level
 * 3. Windows AppContainer 内核级进程、文件系统与网络强隔离：
 *    - 动态创建/派生唯一 AppContainer Profile 与 SID
 *    - 基于 Windows DACL 的受控工作区（Workspace）与临时目录精准授权
 *    - network: deny 模式下清空全部网络 Capabilities，内核级阻断 TCP/UDP/DNS/Loopback
 *    - network: allow 模式下授予受限网络 Capabilities (internetClient, privateNetworkClientServer)
 *    - 执行完毕（或超时强杀）后 100% 自动回滚撤销 ACE 并销毁 Profile，绝不污染宿主原始 ACL
 * 4. 最小权限原则 IPC 匿名管道治理：
 *    - 彻底废除 Everyone (WD) 与 ALL APPLICATION PACKAGES (AC) 宽松权限
 *    - 管道属主为当前登录用户 (GENERIC_ALL)
 *    - 子进程 AppContainer 仅具有 0x120116 (FILE_GENERIC_WRITE | SYNCHRONIZE) 单向写入权限
 * 5. Crash Recovery & Standalone Tooling：
 *    - 提供 --cleanup-profile 与 --revoke-acl 幂等清理入口，配合宿主恢复账本消除孤儿资源
 */

#define WIN32_LEAN_AND_MEAN
#define UNICODE
#define _UNICODE

#include <windows.h>
#include <userenv.h>
#include <sddl.h>
#include <aclapi.h>
#include <tlhelp32.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>
#include <stdint.h>
#include <wctype.h>

#pragma comment(lib, "userenv.lib")
#pragma comment(lib, "advapi32.lib")

#define PROTOCOL_VERSION 2
#define DEFAULT_MAX_BUFFER (10 * 1024 * 1024) /* 10 MB */
#define DEFAULT_TIMEOUT_MS 30000              /* 30 seconds */

/* 线程读取管道缓冲上下文 */
typedef struct {
    HANDLE hPipe;
    HANDLE hStdOutTarget; /* 若非 NULL，将读取到的数据实时写入目标标准流 */
    char *buffer;
    size_t capacity;
    size_t length;
    CRITICAL_SECTION cs;
    bool truncated;
    bool streamOutput;
} PipeReaderContext;

/* UTF-8 转 UTF-16 */
static wchar_t *utf8_to_wide(const char *utf8_str) {
    if (!utf8_str) return NULL;
    int len = MultiByteToWideChar(CP_UTF8, 0, utf8_str, -1, NULL, 0);
    if (len <= 0) return NULL;
    wchar_t *wstr = (wchar_t *)malloc(sizeof(wchar_t) * len);
    if (!wstr) return NULL;
    MultiByteToWideChar(CP_UTF8, 0, utf8_str, -1, wstr, len);
    return wstr;
}

/* 健壮的顶层 JSON 键值定位器 (避免被嵌套对象或字符串内部的关键字欺骗) */
static const char *find_toplevel_key(const char *json, const char *key) {
    if (!json || !key) return NULL;
    const char *p = json;
    while (*p && *p != '{') p++;
    if (!*p) return NULL;
    p++; // 跳过外层 '{'

    int depth = 1;
    size_t key_len = strlen(key);

    while (*p && depth > 0) {
        // 跳过空白与逗号
        while (*p && (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n' || *p == ',')) p++;
        if (!*p) break;

        if (*p == '}') {
            depth--;
            p++;
            continue;
        }
        if (*p == '{') {
            depth++;
            p++;
            continue;
        }

        if (*p == '"') {
            p++;
            const char *str_start = p;
            while (*p) {
                if (*p == '\\') {
                    p++;
                    if (*p) p++;
                } else if (*p == '"') {
                    break;
                } else {
                    p++;
                }
            }
            size_t str_len = p - str_start;
            if (*p == '"') p++;

            // 仅在顶层 (depth == 1) 比对键名
            if (depth == 1 && str_len == key_len && strncmp(str_start, key, key_len) == 0) {
                while (*p && (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n')) p++;
                if (*p == ':') {
                    p++;
                    while (*p && (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n')) p++;
                    return p;
                }
            } else {
                // 跳过对应的冒号和值
                while (*p && (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n')) p++;
                if (*p == ':') {
                    p++;
                    while (*p && (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n')) p++;
                    // 跳过值
                    if (*p == '"') {
                        p++;
                        while (*p) {
                            if (*p == '\\') { p++; if (*p) p++; }
                            else if (*p == '"') { p++; break; }
                            else p++;
                        }
                    } else if (*p == '{' || *p == '[') {
                        int vdepth = 1;
                        char open_ch = *p;
                        char close_ch = (open_ch == '{') ? '}' : ']';
                        p++;
                        while (*p && vdepth > 0) {
                            if (*p == '"') {
                                p++;
                                while (*p) {
                                    if (*p == '\\') { p++; if (*p) p++; }
                                    else if (*p == '"') { p++; break; }
                                    else p++;
                                }
                            } else if (*p == open_ch) {
                                vdepth++;
                                p++;
                            } else if (*p == close_ch) {
                                vdepth--;
                                p++;
                            } else {
                                p++;
                            }
                        }
                    } else {
                        while (*p && *p != ',' && *p != '}' && *p != ']') p++;
                    }
                }
            }
        } else {
            p++;
        }
    }
    return NULL;
}

/* 提取 JSON 字符串 */
static char *extract_json_string(const char *json, const char *key) {
    const char *pos = find_toplevel_key(json, key);
    if (!pos || *pos != '"') return NULL;
    pos++; // 跳过起始双引号

    const char *start = pos;
    while (*pos) {
        if (*pos == '\\') {
            pos++;
            if (*pos) pos++;
        } else if (*pos == '"') {
            break;
        } else {
            pos++;
        }
    }

    size_t raw_len = pos - start;
    char *result = (char *)malloc(raw_len + 1);
    if (!result) return NULL;

    size_t w = 0;
    for (size_t r = 0; r < raw_len; r++) {
        if (start[r] == '\\' && r + 1 < raw_len) {
            r++;
            if (start[r] == 'n') result[w++] = '\n';
            else if (start[r] == 'r') result[w++] = '\r';
            else if (start[r] == 't') result[w++] = '\t';
            else if (start[r] == '"') result[w++] = '"';
            else if (start[r] == '\\') result[w++] = '\\';
            else result[w++] = start[r];
        } else {
            result[w++] = start[r];
        }
    }
    result[w] = '\0';
    return result;
}

/* 提取 JSON 整数字段 */
static long long extract_json_int(const char *json, const char *key, long long default_val) {
    const char *pos = find_toplevel_key(json, key);
    if (!pos) return default_val;
    char *endptr = NULL;
    long long val = _strtoi64(pos, &endptr, 10);
    return (endptr != pos) ? val : default_val;
}

/* 提取 JSON 布尔字段 */
static bool extract_json_bool(const char *json, const char *key, bool default_val) {
    const char *pos = find_toplevel_key(json, key);
    if (!pos) return default_val;
    if (_strnicmp(pos, "true", 4) == 0) return true;
    if (_strnicmp(pos, "false", 5) == 0) return false;
    return default_val;
}

/* 提取 JSON 字符串数组 */
static int extract_json_string_array(const char *json, const char *key, char ***out_items) {
    const char *pos = find_toplevel_key(json, key);
    if (!pos || *pos != '[') {
        *out_items = NULL;
        return 0;
    }
    pos++;

    int count = 0;
    int capacity = 16;
    char **items = (char **)malloc(sizeof(char *) * capacity);
    if (!items) {
        *out_items = NULL;
        return 0;
    }

    while (*pos && *pos != ']') {
        while (*pos == ' ' || *pos == '\t' || *pos == '\r' || *pos == '\n' || *pos == ',') pos++;
        if (*pos == ']') break;
        if (*pos == '"') {
            pos++;
            const char *start = pos;
            while (*pos) {
                if (*pos == '\\') { pos++; if (*pos) pos++; }
                else if (*pos == '"') break;
                else pos++;
            }
            size_t raw_len = pos - start;
            char *item = (char *)malloc(raw_len + 1);
            if (item) {
                size_t w = 0;
                for (size_t r = 0; r < raw_len; r++) {
                    if (start[r] == '\\' && r + 1 < raw_len) {
                        r++;
                        if (start[r] == 'n') item[w++] = '\n';
                        else if (start[r] == 'r') item[w++] = '\r';
                        else if (start[r] == 't') item[w++] = '\t';
                        else if (start[r] == '"') item[w++] = '"';
                        else if (start[r] == '\\') item[w++] = '\\';
                        else item[w++] = start[r];
                    } else {
                        item[w++] = start[r];
                    }
                }
                item[w] = '\0';
                if (count >= capacity) {
                    capacity *= 2;
                    items = (char **)realloc(items, sizeof(char *) * capacity);
                }
                items[count++] = item;
            }
            if (*pos == '"') pos++;
        } else {
            pos++;
        }
    }

    *out_items = items;
    return count;
}

/* 构建 Unicode 环境变量块 */
static wchar_t *build_unicode_env_block(const char *json) {
    const char *pos = find_toplevel_key(json, "env");
    if (!pos || *pos != '{') return NULL;
    pos++;

    size_t capacity = 65536;
    wchar_t *block = (wchar_t *)malloc(sizeof(wchar_t) * capacity);
    if (!block) return NULL;
    size_t offset = 0;

    while (*pos && *pos != '}') {
        while (*pos == ' ' || *pos == '\t' || *pos == '\r' || *pos == '\n' || *pos == ',') pos++;
        if (*pos == '}') break;
        if (*pos == '"') {
            pos++;
            const char *key_start = pos;
            while (*pos) {
                if (*pos == '\\') { pos++; if (*pos) pos++; }
                else if (*pos == '"') break;
                else pos++;
            }
            size_t key_len = pos - key_start;
            char key[256];
            if (key_len < sizeof(key)) {
                strncpy_s(key, sizeof(key), key_start, key_len);
                key[key_len] = '\0';
            } else {
                key[0] = '\0';
            }
            if (*pos == '"') pos++;

            pos = strchr(pos, ':');
            if (!pos) break;
            pos++;
            while (*pos == ' ' || *pos == '\t' || *pos == '\r' || *pos == '\n') pos++;
            if (*pos == '"') {
                pos++;
                const char *val_start = pos;
                while (*pos) {
                    if (*pos == '\\') { pos++; if (*pos) pos++; }
                    else if (*pos == '"') break;
                    else pos++;
                }
                size_t val_len = pos - val_start;
                char *val = (char *)malloc(val_len + 1);
                if (val) {
                    size_t w = 0;
                    for (size_t r = 0; r < val_len; r++) {
                        if (val_start[r] == '\\' && r + 1 < val_len) {
                            r++;
                            if (val_start[r] == 'n') val[w++] = '\n';
                            else if (val_start[r] == 'r') val[w++] = '\r';
                            else if (val_start[r] == 't') val[w++] = '\t';
                            else if (val_start[r] == '"') val[w++] = '"';
                            else if (val_start[r] == '\\') val[w++] = '\\';
                            else val[w++] = val_start[r];
                        } else {
                            val[w++] = val_start[r];
                        }
                    }
                    val[w] = '\0';

                    wchar_t *wKey = utf8_to_wide(key);
                    wchar_t *wVal = utf8_to_wide(val);
                    if (wKey && wVal) {
                        size_t entry_len = wcslen(wKey) + 1 + wcslen(wVal) + 1;
                        if (offset + entry_len + 2 > capacity) {
                            capacity *= 2;
                            block = (wchar_t *)realloc(block, sizeof(wchar_t) * capacity);
                        }
                        swprintf_s(block + offset, capacity - offset, L"%s=%s", wKey, wVal);
                        offset += wcslen(wKey) + 1 + wcslen(wVal);
                        block[offset++] = L'\0';
                    }
                    if (wKey) free(wKey);
                    if (wVal) free(wVal);
                    free(val);
                }
                if (*pos == '"') pos++;
            }
        } else {
            pos++;
        }
    }

    if (offset == 0) {
        free(block);
        return NULL;
    }

    block[offset++] = L'\0';
    return block;
}

/* MAXIMUM_ALLOWED suppresses automatic descendant propagation for ancestor-only metadata grants. */
static DWORD set_path_dacl(LPCWSTR path, PACL acl, BOOL propagate) {
    DWORD attributes = GetFileAttributesW(path);
    if (attributes == INVALID_FILE_ATTRIBUTES) return GetLastError();
    // Opening a running executable with MAXIMUM_ALLOWED requests data-write
    // access and fails image sharing. Files have no descendants to propagate.
    if (propagate || !(attributes & FILE_ATTRIBUTE_DIRECTORY)) return SetNamedSecurityInfoW((LPWSTR)path, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, NULL, NULL, acl, NULL);
    HANDLE file = CreateFileW(path, MAXIMUM_ALLOWED, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        NULL, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, NULL);
    if (file == INVALID_HANDLE_VALUE) return GetLastError();
    DWORD result = SetSecurityInfo(file, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, NULL, NULL, acl, NULL);
    CloseHandle(file);
    return result;
}

/* Recursive ACL propagation must never grant access through an external file alias. */
static BOOL validate_grant_tree(LPCWSTR path, unsigned depth) {
    if (depth > 256) { SetLastError(ERROR_DIRECTORY); return FALSE; }
    DWORD attrs = GetFileAttributesW(path);
    if (attrs == INVALID_FILE_ATTRIBUTES) return FALSE;
    if (attrs & FILE_ATTRIBUTE_REPARSE_POINT) { SetLastError(ERROR_REPARSE_TAG_INVALID); return FALSE; }
    if (!(attrs & FILE_ATTRIBUTE_DIRECTORY)) {
        HANDLE file = CreateFileW(path, FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            NULL, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, NULL);
        if (file == INVALID_HANDLE_VALUE) {
            DWORD err = GetLastError();
            // 若被外部进程独占锁定或拒绝元数据读取，作为常规文件放行遍历，防止意外中断
            if (err == ERROR_SHARING_VIOLATION || err == ERROR_ACCESS_DENIED) return TRUE;
            return FALSE;
        }
        BY_HANDLE_FILE_INFORMATION info;
        BOOL ok = GetFileInformationByHandle(file, &info);
        CloseHandle(file);
        if (!ok || info.nNumberOfLinks > 1) { SetLastError(ERROR_NOT_SUPPORTED); return FALSE; }
        return TRUE;
    }
    size_t length = wcslen(path);
    if (length + 3 >= 32768) { SetLastError(ERROR_FILENAME_EXCED_RANGE); return FALSE; }
    wchar_t *child = (wchar_t *)malloc(32768 * sizeof(wchar_t));
    if (!child) { SetLastError(ERROR_OUTOFMEMORY); return FALSE; }
    swprintf_s(child, 32768, L"%ls\\*", path);
    WIN32_FIND_DATAW entry;
    HANDLE search = FindFirstFileW(child, &entry);
    if (search == INVALID_HANDLE_VALUE) { free(child); return GetLastError() == ERROR_FILE_NOT_FOUND; }
    BOOL ok = TRUE;
    do {
        if (!wcscmp(entry.cFileName, L".") || !wcscmp(entry.cFileName, L"..")) continue;
        if (length + wcslen(entry.cFileName) + 2 >= 32768) { ok = FALSE; break; }
        swprintf_s(child, 32768, L"%ls\\%ls", path, entry.cFileName);
        if (!validate_grant_tree(child, depth + 1)) { ok = FALSE; break; }
    } while (FindNextFileW(search, &entry));
    DWORD error = GetLastError();
    FindClose(search);
    free(child);
    if (ok && error != ERROR_NO_MORE_FILES) ok = FALSE;
    return ok;
}

/* 为指定路径授予特定 AppContainer SID 权限 (ACL 精准授权) */
static BOOL grant_appcontainer_access_unlocked(LPCWSTR path, PSID pSid, DWORD accessMask) {
    if (!path || !pSid) return FALSE;

    PACL pOldDacl = NULL;
    PSECURITY_DESCRIPTOR pSD = NULL;
    DWORD res = GetNamedSecurityInfoW(
        path,
        SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION,
        NULL, NULL,
        &pOldDacl,
        NULL,
        &pSD
    );
    if (res != ERROR_SUCCESS) {
        return FALSE;
    }

    EXPLICIT_ACCESS_W ea;
    ZeroMemory(&ea, sizeof(ea));
    ea.grfAccessPermissions = accessMask;
    ea.grfAccessMode = GRANT_ACCESS;
    ea.grfInheritance = !(GetFileAttributesW(path) & FILE_ATTRIBUTE_DIRECTORY) || accessMask == (FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE) ? NO_INHERITANCE : CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE;
    ea.Trustee.TrusteeForm = TRUSTEE_IS_SID;
    ea.Trustee.TrusteeType = TRUSTEE_IS_WELL_KNOWN_GROUP;
    ea.Trustee.ptstrName = (LPWSTR)pSid;

    PACL pNewDacl = NULL;
    res = SetEntriesInAclW(1, &ea, pOldDacl, &pNewDacl);
    if (res != ERROR_SUCCESS) {
        if (pSD) LocalFree(pSD);
        return FALSE;
    }

    res = set_path_dacl(path, pNewDacl, accessMask != (FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE));

    if (pNewDacl) LocalFree(pNewDacl);
    if (pSD) LocalFree(pSD);
    return (res == ERROR_SUCCESS);
}

/* 从指定路径撤销特定 AppContainer SID 的 ACE (ACL 精准清理回滚) */
static BOOL revoke_appcontainer_access_unlocked(LPCWSTR path, PSID pSid) {
    if (!path || !pSid) return FALSE;

    PACL pOldDacl = NULL;
    PSECURITY_DESCRIPTOR pSD = NULL;
    DWORD res = GetNamedSecurityInfoW(
        path,
        SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION,
        NULL, NULL,
        &pOldDacl,
        NULL,
        &pSD
    );
    if (res != ERROR_SUCCESS) return FALSE;

    BOOL found = FALSE, propagate = FALSE;
    for (DWORD i = 0; pOldDacl && i < pOldDacl->AceCount; i++) {
        ACCESS_ALLOWED_ACE *ace = NULL;
        if (GetAce(pOldDacl, i, (LPVOID *)&ace) && ace->Header.AceType == ACCESS_ALLOWED_ACE_TYPE &&
            EqualSid((PSID)&ace->SidStart, pSid)) {
            found = TRUE;
            if (ace->Header.AceFlags & (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE)) propagate = TRUE;
        }
    }
    if (!found) { if (pSD) LocalFree(pSD); return TRUE; }

    EXPLICIT_ACCESS_W ea;
    ZeroMemory(&ea, sizeof(ea));
    ea.grfAccessPermissions = 0;
    ea.grfAccessMode = REVOKE_ACCESS;
    ea.Trustee.TrusteeForm = TRUSTEE_IS_SID;
    ea.Trustee.TrusteeType = TRUSTEE_IS_WELL_KNOWN_GROUP;
    ea.Trustee.ptstrName = (LPWSTR)pSid;

    PACL pNewDacl = NULL;
    res = SetEntriesInAclW(1, &ea, pOldDacl, &pNewDacl);
    if (res == ERROR_SUCCESS) {
        res = set_path_dacl(path, pNewDacl, propagate);
    }

    if (pNewDacl) LocalFree(pNewDacl);
    if (pSD) LocalFree(pSD);
    return res == ERROR_SUCCESS;
}

/* Independent helpers share tool runtime directories; ACL read/modify/write must be atomic. */
static HANDLE lock_acl_path(LPCWSTR path) {
    wchar_t full[32768];
    DWORD length = GetFullPathNameW(path, 32768, full, NULL);
    if (!length || length >= 32768) return NULL;
    uint64_t hash = 14695981039346656037ULL;
    for (DWORD i = 0; i < length; i++) { hash ^= (uint64_t)towlower(full[i]); hash *= 1099511628211ULL; }
    wchar_t name[96];
    swprintf_s(name, 96, L"Local\\NashSandboxAcl_%016llx", (unsigned long long)hash);
    HANDLE mutex = CreateMutexW(NULL, FALSE, name);
    if (!mutex) return NULL;
    DWORD result = WaitForSingleObject(mutex, 15000);
    if (result != WAIT_OBJECT_0 && result != WAIT_ABANDONED) { CloseHandle(mutex); return NULL; }
    return mutex;
}

static BOOL grant_appcontainer_access(LPCWSTR path, PSID sid, DWORD access) {
    HANDLE mutex = lock_acl_path(path);
    if (!mutex) return FALSE;
    BOOL result = grant_appcontainer_access_unlocked(path, sid, access);
    ReleaseMutex(mutex); CloseHandle(mutex);
    return result;
}

static BOOL revoke_appcontainer_access(LPCWSTR path, PSID sid) {
    HANDLE mutex = lock_acl_path(path);
    if (!mutex) return FALSE;
    BOOL result = revoke_appcontainer_access_unlocked(path, sid);
    ReleaseMutex(mutex); CloseHandle(mutex);
    return result;
}

/* 创建最小权限管道安全描述符 (Principle of Least Privilege) */
static PSECURITY_DESCRIPTOR create_minimal_object_sd(PSID pAppContainerSid, DWORD accessMask) {
    HANDLE hToken = NULL;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &hToken)) {
        return NULL;
    }

    DWORD len = 0;
    GetTokenInformation(hToken, TokenUser, NULL, 0, &len);
    if (len == 0) {
        CloseHandle(hToken);
        return NULL;
    }

    PTOKEN_USER pUser = (PTOKEN_USER)malloc(len);
    if (!pUser || !GetTokenInformation(hToken, TokenUser, pUser, len, &len)) {
        if (pUser) free(pUser);
        CloseHandle(hToken);
        return NULL;
    }

    LPWSTR strUserSid = NULL;
    if (!ConvertSidToStringSidW(pUser->User.Sid, &strUserSid)) {
        free(pUser);
        CloseHandle(hToken);
        return NULL;
    }

    LPWSTR strAppContainerSid = NULL;
    if (pAppContainerSid) {
        ConvertSidToStringSidW(pAppContainerSid, &strAppContainerSid);
    }

    /* 构建受限 SDDL：
     * - 当前用户具有 GENERIC_ALL (GA)
     * - 专属 AppContainer SID 仅具有 0x120116 (FILE_GENERIC_WRITE | SYNCHRONIZE)
     * - 彻底移除 Everyone (WD)，彻底移除 ALL APPLICATION PACKAGES (AC)
     */
    wchar_t sddl[1024];
    if (strAppContainerSid) {
        swprintf_s(sddl, 1024, L"D:(A;;GA;;;%s)(A;;0x%08lx;;;%s)", strUserSid, accessMask, strAppContainerSid);
    } else {
        swprintf_s(sddl, 1024, L"D:(A;;GA;;;%s)", strUserSid);
    }

    PSECURITY_DESCRIPTOR pSD = NULL;
    ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, SDDL_REVISION_1, &pSD, NULL);

    if (strAppContainerSid) LocalFree(strAppContainerSid);
    LocalFree(strUserSid);
    free(pUser);
    CloseHandle(hToken);
    return pSD;
}

/* Pin the actual parent process object, not only its recyclable numeric PID. */
static HANDLE open_owner_process(void) {
    DWORD parentPid = 0;
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    PROCESSENTRY32W entry = { sizeof(PROCESSENTRY32W) };
    if (snapshot == INVALID_HANDLE_VALUE) return NULL;
    if (Process32FirstW(snapshot, &entry)) do {
        if (entry.th32ProcessID == GetCurrentProcessId()) { parentPid = entry.th32ParentProcessID; break; }
    } while (Process32NextW(snapshot, &entry));
    CloseHandle(snapshot);
    if (!parentPid) return NULL;
    HANDLE owner = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, parentPid);
    if (!owner) return NULL;
    FILETIME ownerCreated, selfCreated, exited, kernel, user;
    if (!GetProcessTimes(owner, &ownerCreated, &exited, &kernel, &user) ||
        !GetProcessTimes(GetCurrentProcess(), &selfCreated, &exited, &kernel, &user) ||
        CompareFileTime(&ownerCreated, &selfCreated) > 0) {
        CloseHandle(owner); return NULL;
    }
    return owner;
}

/* Windows 参数转义 (根据 Microsoft C runtime / CommandLineToArgvW 规则) */
static void append_quoted_arg(wchar_t *cmdline, size_t max_len, const wchar_t *arg) {
    if (!arg) return;
    bool needs_quotes = (wcschr(arg, L' ') != NULL || wcschr(arg, L'\t') != NULL || wcschr(arg, L'"') != NULL || *arg == L'\0');

    if (!needs_quotes) {
        wcsncat_s(cmdline, max_len, arg, _TRUNCATE);
        return;
    }

    wcsncat_s(cmdline, max_len, L"\"", _TRUNCATE);
    size_t backslashes = 0;
    for (const wchar_t *p = arg; *p != L'\0'; p++) {
        if (*p == L'\\') {
            backslashes++;
        } else if (*p == L'"') {
            for (size_t b = 0; b < backslashes * 2 + 1; b++) {
                wcsncat_s(cmdline, max_len, L"\\", _TRUNCATE);
            }
            backslashes = 0;
            wcsncat_s(cmdline, max_len, L"\"", _TRUNCATE);
        } else {
            for (size_t b = 0; b < backslashes; b++) {
                wcsncat_s(cmdline, max_len, L"\\", _TRUNCATE);
            }
            backslashes = 0;
            wchar_t ch[2] = { *p, L'\0' };
            wcsncat_s(cmdline, max_len, ch, _TRUNCATE);
        }
    }
    for (size_t b = 0; b < backslashes * 2; b++) {
        wcsncat_s(cmdline, max_len, L"\\", _TRUNCATE);
    }
    wcsncat_s(cmdline, max_len, L"\"", _TRUNCATE);
}

/* 管道读取线程函数 (支持实时流式直接写入宿主标准流) */
static DWORD WINAPI pipe_reader_thread(LPVOID param) {
    PipeReaderContext *ctx = (PipeReaderContext *)param;
    char chunk[4096];
    DWORD bytesRead = 0;

    while (ReadFile(ctx->hPipe, chunk, sizeof(chunk), &bytesRead, NULL) && bytesRead > 0) {
        if (ctx->streamOutput && ctx->hStdOutTarget) {
            DWORD written = 0;
            WriteFile(ctx->hStdOutTarget, chunk, bytesRead, &written, NULL);
        }

        EnterCriticalSection(&ctx->cs);
        if (ctx->buffer && ctx->length + bytesRead <= ctx->capacity) {
            memcpy(ctx->buffer + ctx->length, chunk, bytesRead);
            ctx->length += bytesRead;
        } else if (ctx->buffer) {
            size_t remaining = ctx->capacity > ctx->length ? ctx->capacity - ctx->length : 0;
            if (remaining > 0) {
                memcpy(ctx->buffer + ctx->length, chunk, remaining);
                ctx->length += remaining;
            }
            ctx->truncated = true;
        }
        LeaveCriticalSection(&ctx->cs);
    }
    return 0;
}

/* 输出 JSON 转义字符串 */
static void print_json_escaped(const char *str, size_t len) {
    putchar('"');
    for (size_t i = 0; i < len; i++) {
        unsigned char c = (unsigned char)str[i];
        switch (c) {
            case '"':  fputs("\\\"", stdout); break;
            case '\\': fputs("\\\\", stdout); break;
            case '\b': fputs("\\b", stdout); break;
            case '\f': fputs("\\f", stdout); break;
            case '\n': fputs("\\n", stdout); break;
            case '\r': fputs("\\r", stdout); break;
            case '\t': fputs("\\t", stdout); break;
            default:
                if (c < 32) {
                    printf("\\u%04x", c);
                } else {
                    putchar(c);
                }
                break;
        }
    }
    putchar('"');
}

/* 打印版本 JSON */
static void print_version_json(void) {
    /* 测试 Job Objects */
    HANDLE hJob = CreateJobObjectW(NULL, NULL);
    bool job_ok = (hJob != NULL);
    if (hJob) CloseHandle(hJob);

    /* 测试 Restricted Token */
    bool token_ok = false;
    HANDLE hToken = NULL;
    if (OpenProcessToken(GetCurrentProcess(), TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY | TOKEN_QUERY | TOKEN_ADJUST_DEFAULT, &hToken)) {
        HANDLE hRestricted = NULL;
        if (CreateRestrictedToken(hToken, DISABLE_MAX_PRIVILEGE, 0, NULL, 0, NULL, 0, NULL, &hRestricted)) {
            token_ok = true;
            CloseHandle(hRestricted);
        }
        CloseHandle(hToken);
    }

    /* 测试 AppContainer (优先使用纯内存 SID 派生，彻底消除多进程并发探测注册表冲突) */
    bool appcontainer_ok = false;
    PSID pSid = NULL;
    HRESULT hr = DeriveAppContainerSidFromAppContainerName(L"NashProbeCheck", &pSid);
    if (SUCCEEDED(hr) && pSid) {
        appcontainer_ok = true;
        FreeSid(pSid);
    } else {
        wchar_t probeName[64];
        swprintf_s(probeName, 64, L"NashProbe_%lu", GetCurrentProcessId());
        hr = CreateAppContainerProfile(
            probeName,
            probeName,
            L"Nash Probe Check",
            NULL, 0,
            &pSid
        );
        if (SUCCEEDED(hr)) {
            appcontainer_ok = true;
            if (pSid) FreeSid(pSid);
            DeleteAppContainerProfile(probeName);
        } else if (hr == HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS)) {
            appcontainer_ok = true;
        }
    }

    printf("{\"protocolVersion\":%d,\"platform\":\"win32\",\"arch\":\"x64\",\"jobObjects\":%s,\"restrictedToken\":%s,\"appContainer\":%s,\"networkIsolation\":%s,\"filesystemIsolation\":%s,\"integrityLevels\":true}\n",
           PROTOCOL_VERSION,
           job_ok ? "true" : "false",
           token_ok ? "true" : "false",
           appcontainer_ok ? "true" : "false",
           appcontainer_ok ? "true" : "false",
           appcontainer_ok ? "true" : "false");
}

/* 执行沙箱进程核心逻辑 */
static int run_sandbox_internal(
    const char *command,
    char **args,
    int arg_count,
    const char *cwd,
    long long timeout_ms,
    long long max_buffer,
    long long max_processes,
    long long memory_limit_bytes,
    long long cpu_rate_limit,
    bool drop_admin,
    bool restricted_token_enabled,
    bool stream_output,
    wchar_t *env_block,
    bool appcontainer_enabled,
    const char *appcontainer_name,
    bool network_allow,
    char **allowed_read_paths,
    int allowed_read_path_count,
    char **allowed_write_paths,
    int allowed_write_path_count
) {
    HANDLE ownerProcess = open_owner_process();
    if (!ownerProcess) {
        fprintf(stderr, "Cannot establish sandbox owner process identity (Fail-Closed)\n");
        return 1;
    }
    /* 1. 构造完整命令行 (wchar_t) */
    size_t cmdline_max = 65536;
    wchar_t *cmdline = (wchar_t *)malloc(sizeof(wchar_t) * cmdline_max);
    if (!cmdline) return 1;
    cmdline[0] = L'\0';

    wchar_t *wcommand = utf8_to_wide(command);
    append_quoted_arg(cmdline, cmdline_max, wcommand);

    for (int i = 0; i < arg_count; i++) {
        wcsncat_s(cmdline, cmdline_max, L" ", _TRUNCATE);
        wchar_t *warg = utf8_to_wide(args[i]);
        append_quoted_arg(cmdline, cmdline_max, warg);
        free(warg);
    }

    wchar_t *wcwd = cwd ? utf8_to_wide(cwd) : NULL;

    /* 2. 创建独立 Job Object */
    HANDLE hJob = CreateJobObjectW(NULL, NULL);
    if (!hJob) {
        if (stream_output) {
            fprintf(stderr, "CreateJobObjectW failed: %lu\n", GetLastError());
        } else {
            printf("{\"exitCode\":1,\"stdout\":\"\",\"stderr\":\"CreateJobObjectW failed\",\"killed\":false}\n");
        }
        free(cmdline);
        free(wcommand);
        if (wcwd) free(wcwd);
        return 1;
    }

    JOBOBJECT_EXTENDED_LIMIT_INFORMATION jeli;
    ZeroMemory(&jeli, sizeof(jeli));
    jeli.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;

    if (max_processes > 0) {
        jeli.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
        jeli.BasicLimitInformation.ActiveProcessLimit = (DWORD)max_processes;
    }
    if (memory_limit_bytes > 0) {
        jeli.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_JOB_MEMORY;
        jeli.JobMemoryLimit = (SIZE_T)memory_limit_bytes;
    }

    if (!SetInformationJobObject(hJob, JobObjectExtendedLimitInformation, &jeli, sizeof(jeli))) {
        if (stream_output) {
            fprintf(stderr, "SetInformationJobObject failed: %lu\n", GetLastError());
        } else {
            printf("{\"exitCode\":1,\"stdout\":\"\",\"stderr\":\"SetInformationJobObject failed\",\"killed\":false}\n");
        }
        CloseHandle(hJob);
        free(cmdline);
        free(wcommand);
        if (wcwd) free(wcwd);
        return 1;
    }

    if (cpu_rate_limit > 0 && cpu_rate_limit <= 100) {
        JOBOBJECT_CPU_RATE_CONTROL_INFORMATION cpu_info;
        ZeroMemory(&cpu_info, sizeof(cpu_info));
        cpu_info.ControlFlags = JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP;
        cpu_info.CpuRate = (DWORD)(cpu_rate_limit * 100);
        SetInformationJobObject(hJob, JobObjectCpuRateControlInformation, &cpu_info, sizeof(cpu_info));
    }

    /* 3. 处理 AppContainer 状态 (提前创建，以便管道与 ACL 精准绑定 SID) */
    PSID pAppContainerSid = NULL;
    wchar_t wProfileName[256];
    wProfileName[0] = L'\0';
    LPPROC_THREAD_ATTRIBUTE_LIST pAttrList = NULL;
    SECURITY_CAPABILITIES secCaps;
    ZeroMemory(&secCaps, sizeof(secCaps));
    SID_AND_ATTRIBUTES networkCapabilities[2];
    ZeroMemory(&networkCapabilities, sizeof(networkCapabilities));
    DWORD capabilityCount = 0;
    HANDLE inheritHandles[3];
    DWORD inheritHandleCount = 0;

    HANDLE hStdoutRead = NULL, hStdoutWrite = NULL;
    HANDLE hStderrRead = NULL, hStderrWrite = NULL;
    HANDLE hPrimaryToken = NULL;
    HWINSTA privateStation = NULL;
    HDESK privateDesktop = NULL;
    bool attributesInitialized = false;

    wchar_t **granted_read_wpaths = NULL;
    wchar_t **granted_write_wpaths = NULL;

    if (appcontainer_enabled) {
        if (appcontainer_name && strlen(appcontainer_name) > 0) {
            wchar_t *tmpName = utf8_to_wide(appcontainer_name);
            if (tmpName) {
                wcsncpy_s(wProfileName, sizeof(wProfileName) / sizeof(wchar_t), tmpName, _TRUNCATE);
                free(tmpName);
            }
        } else {
            LARGE_INTEGER qpc;
            QueryPerformanceCounter(&qpc);
            swprintf_s(wProfileName, sizeof(wProfileName) / sizeof(wchar_t), L"NashSandbox_%lu_%I64u_%lu",
                       GetCurrentProcessId(), (unsigned __int64)GetTickCount64(), (unsigned long)(qpc.LowPart & 0xFFFF));
        }

        HRESULT hr = CreateAppContainerProfile(
            wProfileName,
            wProfileName,
            L"Nash Sandboxed Runtime",
            NULL,
            0,
            &pAppContainerSid
        );
        if (hr == HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS)) {
            hr = DeriveAppContainerSidFromAppContainerName(wProfileName, &pAppContainerSid);
        }

        if (FAILED(hr) || !pAppContainerSid) {
            if (stream_output) {
                fprintf(stderr, "CreateAppContainerProfile failed: 0x%08X\n", hr);
            } else {
                printf("{\"exitCode\":1,\"stdout\":\"\",\"stderr\":\"CreateAppContainerProfile failed 0x%08X\",\"killed\":false}\n", hr);
            }
            CloseHandle(hJob);
            free(cmdline);
            free(wcommand);
            if (wcwd) free(wcwd);
            return 1;
        }

        /* 3.1 网络隔离 Capability 处理 */
        if (network_allow) {
            // 授予 InternetClient (S-1-15-3-1) 与 PrivateNetworkClientServer (S-1-15-3-3)
            PSID pSidInternet = NULL;
            PSID pSidPrivate = NULL;
            if (ConvertStringSidToSidW(L"S-1-15-3-1", &pSidInternet) && pSidInternet) {
                networkCapabilities[capabilityCount].Sid = pSidInternet;
                networkCapabilities[capabilityCount].Attributes = SE_GROUP_ENABLED;
                capabilityCount++;
            }
            if (ConvertStringSidToSidW(L"S-1-15-3-3", &pSidPrivate) && pSidPrivate) {
                networkCapabilities[capabilityCount].Sid = pSidPrivate;
                networkCapabilities[capabilityCount].Attributes = SE_GROUP_ENABLED;
                capabilityCount++;
            }
            secCaps.Capabilities = networkCapabilities;
            secCaps.CapabilityCount = capabilityCount;
        } else {
            // network: deny => 0 Capabilities, 完全无网络
            secCaps.Capabilities = NULL;
            secCaps.CapabilityCount = 0;
        }
        secCaps.AppContainerSid = pAppContainerSid;

        /* 3.2 文件系统 ACL 授权 */
        if (allowed_read_path_count > 0) {
            granted_read_wpaths = (wchar_t **)calloc((size_t)allowed_read_path_count, sizeof(wchar_t *));
            if (!granted_read_wpaths) goto setup_failed;
            for (int i = 0; i < allowed_read_path_count; i++) {
                granted_read_wpaths[i] = utf8_to_wide(allowed_read_paths[i]);
                if (granted_read_wpaths[i]) {
                    if (!validate_grant_tree(granted_read_wpaths[i], 0)) {
                        fprintf(stderr, "Unsafe ACL tree: hard link, reparse point, or inaccessible entry (Fail-Closed)\n");
                        goto setup_failed;
                    }
                    grant_appcontainer_access(granted_read_wpaths[i], pAppContainerSid, FILE_GENERIC_READ | FILE_GENERIC_EXECUTE);
                }
            }
        }
        if (allowed_write_path_count > 0) {
            granted_write_wpaths = (wchar_t **)calloc((size_t)allowed_write_path_count, sizeof(wchar_t *));
            if (!granted_write_wpaths) goto setup_failed;
            for (int i = 0; i < allowed_write_path_count; i++) {
                granted_write_wpaths[i] = utf8_to_wide(allowed_write_paths[i]);
                if (granted_write_wpaths[i]) {
                    if (!validate_grant_tree(granted_write_wpaths[i], 0)) {
                        fprintf(stderr, "Unsafe ACL tree: hard link, reparse point, or inaccessible entry (Fail-Closed)\n");
                        goto setup_failed;
                    }
                    grant_appcontainer_access(granted_write_wpaths[i], pAppContainerSid, FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE);
                }
            }
        }
    }

    /* 4. 创建最小权限匿名管道 (配置安全描述符严格绑定专属 AppContainer SID 与当前用户) */
    SECURITY_ATTRIBUTES sa;
    ZeroMemory(&sa, sizeof(sa));
    sa.nLength = sizeof(sa);
    sa.bInheritHandle = TRUE;
    sa.lpSecurityDescriptor = create_minimal_object_sd(pAppContainerSid, FILE_GENERIC_WRITE);


    if (!CreatePipe(&hStdoutRead, &hStdoutWrite, &sa, 0) ||
        !CreatePipe(&hStderrRead, &hStderrWrite, &sa, 0)) {
        if (sa.lpSecurityDescriptor) LocalFree(sa.lpSecurityDescriptor);
        if (stream_output) {
            fprintf(stderr, "CreatePipe failed: %lu\n", GetLastError());
        } else {
            printf("{\"exitCode\":1,\"stdout\":\"\",\"stderr\":\"CreatePipe failed\",\"killed\":false}\n");
        }
        goto setup_failed;
    }
    if (sa.lpSecurityDescriptor) LocalFree(sa.lpSecurityDescriptor);

    SetHandleInformation(hStdoutRead, HANDLE_FLAG_INHERIT, 0);
    SetHandleInformation(hStderrRead, HANDLE_FLAG_INHERIT, 0);

    /* 5. 构造 PROC_THREAD_ATTRIBUTE_LIST */
    if (appcontainer_enabled) {
        SIZE_T attrSize = 0;
        InitializeProcThreadAttributeList(NULL, 2, 0, &attrSize);
        pAttrList = (LPPROC_THREAD_ATTRIBUTE_LIST)malloc(attrSize);
        if (pAttrList && InitializeProcThreadAttributeList(pAttrList, 2, 0, &attrSize)) {
            attributesInitialized = true;
            if (!UpdateProcThreadAttribute(
                pAttrList,
                0,
                PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
                &secCaps,
                sizeof(secCaps),
                NULL,
                NULL
            )) {
                fprintf(stderr, "Security capabilities initialization failed (Fail-Closed): %lu\n", GetLastError());
                goto setup_failed;
            }

            inheritHandles[0] = GetStdHandle(STD_INPUT_HANDLE);
            inheritHandles[1] = hStdoutWrite;
            inheritHandles[2] = hStderrWrite;
            inheritHandleCount = 3;

            if (!UpdateProcThreadAttribute(
                pAttrList,
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                inheritHandles,
                sizeof(HANDLE) * inheritHandleCount,
                NULL,
                NULL
            )) {
                fprintf(stderr, "Handle inheritance initialization failed (Fail-Closed): %lu\n", GetLastError());
                goto setup_failed;
            }
        } else {
            fprintf(stderr, "Process attributes initialization failed (Fail-Closed): %lu\n", GetLastError());
            goto setup_failed;
        }
    }

    /* 6. 准备 Restricted Token (若非 AppContainer 模式且请求降权) */
    if (!appcontainer_enabled && (drop_admin || restricted_token_enabled)) {
        HANDLE hCurrentToken = NULL;
        if (OpenProcessToken(GetCurrentProcess(), TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY | TOKEN_QUERY | TOKEN_ADJUST_DEFAULT, &hCurrentToken)) {
            HANDLE hRestricted = NULL;
            if (CreateRestrictedToken(hCurrentToken, DISABLE_MAX_PRIVILEGE, 0, NULL, 0, NULL, 0, NULL, &hRestricted)) {
                DuplicateTokenEx(
                    hRestricted,
                    TOKEN_ALL_ACCESS,
                    NULL,
                    SecurityImpersonation,
                    TokenPrimary,
                    &hPrimaryToken
                );
                CloseHandle(hRestricted);
            }
            CloseHandle(hCurrentToken);
        }
    }

    // SSH/service logons can have an inaccessible desktop. Use task-private USER objects,
    // never modify winsta0/default or ALL APPLICATION PACKAGES ACLs.
    wchar_t desktopPath[256] = L"";
    if (appcontainer_enabled) {
        wchar_t stationName[128];
        swprintf_s(stationName, 128, L"Nash_%lu_%llu", GetCurrentProcessId(), GetTickCount64());
        SECURITY_ATTRIBUTES objectSa = { sizeof(SECURITY_ATTRIBUTES), NULL, FALSE };
        objectSa.lpSecurityDescriptor = create_minimal_object_sd(pAppContainerSid,
            READ_CONTROL | WINSTA_READATTRIBUTES | WINSTA_ACCESSGLOBALATOMS | WINSTA_ENUMDESKTOPS | WINSTA_ENUMERATE);
        HWINSTA original = GetProcessWindowStation();
        if (objectSa.lpSecurityDescriptor) privateStation = CreateWindowStationW(stationName, CWF_CREATE_ONLY, WINSTA_ALL_ACCESS, &objectSa);
        if (objectSa.lpSecurityDescriptor) LocalFree(objectSa.lpSecurityDescriptor);
        if (privateStation && SetProcessWindowStation(privateStation)) {
            objectSa.lpSecurityDescriptor = create_minimal_object_sd(pAppContainerSid,
                READ_CONTROL | DESKTOP_CREATEWINDOW | DESKTOP_CREATEMENU | DESKTOP_READOBJECTS | DESKTOP_WRITEOBJECTS);
            if (objectSa.lpSecurityDescriptor) privateDesktop = CreateDesktopW(L"default", NULL, NULL, 0, GENERIC_ALL, &objectSa);
            if (objectSa.lpSecurityDescriptor) LocalFree(objectSa.lpSecurityDescriptor);
            SetProcessWindowStation(original);
        }
        if (!privateStation || !privateDesktop) {
            fprintf(stderr, "Task-private desktop initialization failed: %lu\n", GetLastError());
            goto setup_failed;
        }
        swprintf_s(desktopPath, 256, L"%ls\\default", stationName);
    }

    /* 7. 启动挂起进程 (CREATE_SUSPENDED) 确保在执行前加入 Job Object */
    STARTUPINFOEXW siex;
    ZeroMemory(&siex, sizeof(siex));
    siex.StartupInfo.cb = sizeof(STARTUPINFOEXW);
    siex.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    if (privateDesktop) siex.StartupInfo.lpDesktop = desktopPath;
    siex.StartupInfo.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    siex.StartupInfo.hStdOutput = hStdoutWrite;
    siex.StartupInfo.hStdError = hStderrWrite;
    if (pAttrList) {
        siex.lpAttributeList = pAttrList;
    }

    PROCESS_INFORMATION pi;
    ZeroMemory(&pi, sizeof(pi));

    DWORD creation_flags = CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NEW_PROCESS_GROUP;
    if (pAttrList) {
        creation_flags |= EXTENDED_STARTUPINFO_PRESENT;
    }

    BOOL proc_created = FALSE;
    if (hPrimaryToken) {
        proc_created = CreateProcessAsUserW(
            hPrimaryToken,
            NULL,
            cmdline,
            NULL,
            NULL,
            TRUE,
            creation_flags,
            env_block,
            wcwd,
            &siex.StartupInfo,
            &pi
        );
        CloseHandle(hPrimaryToken); hPrimaryToken = NULL;
    } else {
        proc_created = CreateProcessW(
            NULL,
            cmdline,
            NULL,
            NULL,
            TRUE,
            creation_flags,
            env_block,
            wcwd,
            &siex.StartupInfo,
            &pi
        );
    }

    /* 无论成功与否，父进程关闭管道写端 */
    CloseHandle(hStdoutWrite); hStdoutWrite = NULL;
    CloseHandle(hStderrWrite); hStderrWrite = NULL;

    if (!proc_created) {
        DWORD err = GetLastError();
        if (stream_output) {
            fprintf(stderr, "CreateProcessW failed with error %lu\n", err);
        } else {
            printf("{\"exitCode\":1,\"stdout\":\"\",\"stderr\":\"CreateProcessW failed with error %lu\",\"killed\":false}\n", err);
        }

        goto setup_failed;
    }

    /* 8. Assign while suspended; a failed assignment never runs target code. */
    if (!AssignProcessToJobObject(hJob, pi.hProcess)) {
        fprintf(stderr, "AssignProcessToJobObject failed: %lu\n", GetLastError());
        TerminateProcess(pi.hProcess, 1);
        WaitForSingleObject(pi.hProcess, INFINITE);
        CloseHandle(pi.hProcess); CloseHandle(pi.hThread);
        goto setup_failed;
    }

    /* 9. 启动管道异步读取线程 */
    PipeReaderContext out_ctx, err_ctx;
    ZeroMemory(&out_ctx, sizeof(out_ctx));
    ZeroMemory(&err_ctx, sizeof(err_ctx));

    InitializeCriticalSection(&out_ctx.cs);
    InitializeCriticalSection(&err_ctx.cs);

    out_ctx.hPipe = hStdoutRead;
    out_ctx.hStdOutTarget = stream_output ? GetStdHandle(STD_OUTPUT_HANDLE) : NULL;
    out_ctx.streamOutput = stream_output;
    out_ctx.capacity = (size_t)max_buffer;
    out_ctx.buffer = (char *)malloc(out_ctx.capacity + 1);

    err_ctx.hPipe = hStderrRead;
    err_ctx.hStdOutTarget = stream_output ? GetStdHandle(STD_ERROR_HANDLE) : NULL;
    err_ctx.streamOutput = stream_output;
    err_ctx.capacity = (size_t)max_buffer;
    err_ctx.buffer = (char *)malloc(err_ctx.capacity + 1);

    HANDLE hOutThread = CreateThread(NULL, 0, pipe_reader_thread, &out_ctx, 0, NULL);
    HANDLE hErrThread = CreateThread(NULL, 0, pipe_reader_thread, &err_ctx, 0, NULL);

    /* 10. 恢复线程执行 (ResumeThread) */
    ResumeThread(pi.hThread);
    CloseHandle(pi.hThread);

    /* 11. 等待进程结束或超时 */
    HANDLE waitHandles[2] = { pi.hProcess, ownerProcess };
    DWORD wait_res = WaitForMultipleObjects(2, waitHandles, FALSE, (DWORD)timeout_ms);
    bool killed = false;

    if (wait_res == WAIT_TIMEOUT || wait_res == WAIT_OBJECT_0 + 1 || wait_res == WAIT_FAILED) {
        killed = true;
        /* 通过 Job Object 强力终止所有子孙进程！ */
        TerminateJobObject(hJob, 1);
        WaitForSingleObject(pi.hProcess, 5000);
        if (stream_output) {
            fprintf(stderr, "\nCommand timed out or owner exited. Controlled process tree terminated by Job Object.\n");
        }
    }

    /* Descendants must release pipe writers before reader contexts can be destroyed. */
    TerminateJobObject(hJob, 1);
    if (hOutThread) {
        if (WaitForSingleObject(hOutThread, 2000) == WAIT_TIMEOUT) CancelSynchronousIo(hOutThread);
        WaitForSingleObject(hOutThread, INFINITE);
        CloseHandle(hOutThread);
    }
    if (hErrThread) {
        if (WaitForSingleObject(hErrThread, 2000) == WAIT_TIMEOUT) CancelSynchronousIo(hErrThread);
        WaitForSingleObject(hErrThread, INFINITE);
        CloseHandle(hErrThread);
    }
    CloseHandle(hStdoutRead);
    CloseHandle(hStderrRead);

    DWORD exitCode = 0;
    GetExitCodeProcess(pi.hProcess, &exitCode);

    CloseHandle(pi.hProcess);
    CloseHandle(ownerProcess);
    CloseHandle(hJob);

    /* 13. 清理与回滚 ACL 和 AppContainer 资源 (100% 确保恢复) */
    if (appcontainer_enabled) {
        if (granted_read_wpaths) {
            for (int i = 0; i < allowed_read_path_count; i++) {
                if (granted_read_wpaths[i]) {
                    revoke_appcontainer_access(granted_read_wpaths[i], pAppContainerSid);
                    free(granted_read_wpaths[i]);
                }
            }
            free(granted_read_wpaths);
        }
        if (granted_write_wpaths) {
            for (int i = 0; i < allowed_write_path_count; i++) {
                if (granted_write_wpaths[i]) {
                    revoke_appcontainer_access(granted_write_wpaths[i], pAppContainerSid);
                    free(granted_write_wpaths[i]);
                }
            }
            free(granted_write_wpaths);
        }
        if (pAttrList) {
            DeleteProcThreadAttributeList(pAttrList);
            free(pAttrList);
        }
        for (DWORD i = 0; i < capabilityCount; i++) {
            if (networkCapabilities[i].Sid) LocalFree(networkCapabilities[i].Sid);
        }
        if (pAppContainerSid) FreeSid(pAppContainerSid);
        if (wProfileName[0] != L'\0') DeleteAppContainerProfile(wProfileName);
    }

    if (privateDesktop) CloseDesktop(privateDesktop);
    if (privateStation) CloseWindowStation(privateStation);

    /* 14. 结构化输出或返回退出码 */
    if (!stream_output) {
        printf("{\"exitCode\":%lu,\"stdout\":", exitCode);
        print_json_escaped(out_ctx.buffer ? out_ctx.buffer : "", out_ctx.length);
        printf(",\"stderr\":");
        print_json_escaped(err_ctx.buffer ? err_ctx.buffer : "", err_ctx.length);
        printf(",\"killed\":%s}\n", killed ? "true" : "false");
    }

    /* 清理内存 */
    if (out_ctx.buffer) free(out_ctx.buffer);
    if (err_ctx.buffer) free(err_ctx.buffer);
    DeleteCriticalSection(&out_ctx.cs);
    DeleteCriticalSection(&err_ctx.cs);

    free(cmdline);
    free(wcommand);
    if (wcwd) free(wcwd);

    return killed ? 1 : (int)exitCode;

setup_failed:
    if (hStdoutRead) CloseHandle(hStdoutRead);
    if (hStdoutWrite) CloseHandle(hStdoutWrite);
    if (hStderrRead) CloseHandle(hStderrRead);
    if (hStderrWrite) CloseHandle(hStderrWrite);
    if (hPrimaryToken) CloseHandle(hPrimaryToken);
    if (privateDesktop) CloseDesktop(privateDesktop);
    if (privateStation) CloseWindowStation(privateStation);
    if (granted_read_wpaths) {
        for (int i = 0; i < allowed_read_path_count; i++) if (granted_read_wpaths[i]) {
            revoke_appcontainer_access(granted_read_wpaths[i], pAppContainerSid);
            free(granted_read_wpaths[i]);
        }
        free(granted_read_wpaths);
    }
    if (granted_write_wpaths) {
        for (int i = 0; i < allowed_write_path_count; i++) if (granted_write_wpaths[i]) {
            revoke_appcontainer_access(granted_write_wpaths[i], pAppContainerSid);
            free(granted_write_wpaths[i]);
        }
        free(granted_write_wpaths);
    }
    if (pAttrList) { if (attributesInitialized) DeleteProcThreadAttributeList(pAttrList); free(pAttrList); }
    for (DWORD i = 0; i < capabilityCount; i++) if (networkCapabilities[i].Sid) LocalFree(networkCapabilities[i].Sid);
    if (pAppContainerSid) FreeSid(pAppContainerSid);
    if (wProfileName[0] != L'\0') DeleteAppContainerProfile(wProfileName);
    CloseHandle(hJob); CloseHandle(ownerProcess);
    free(cmdline); free(wcommand); if (wcwd) free(wcwd);
    return 1;
}

/* 执行 JSON 配置流程 */
static int run_sandbox_from_json(const char *config_json, bool force_stream) {
    int protocol = (int)extract_json_int(config_json, "protocolVersion", PROTOCOL_VERSION);
    if (protocol != PROTOCOL_VERSION && protocol != 1) {
        fprintf(stderr, "Protocol version mismatch: expected %d or 1, got %d\n", PROTOCOL_VERSION, protocol);
        return 1;
    }

    char *command = extract_json_string(config_json, "command");
    if (!command || strlen(command) == 0) {
        fprintf(stderr, "Missing 'command' in config\n");
        return 1;
    }

    char **args = NULL;
    int arg_count = extract_json_string_array(config_json, "args", &args);
    char *cwd = extract_json_string(config_json, "cwd");
    long long timeout_ms = extract_json_int(config_json, "timeoutMs", DEFAULT_TIMEOUT_MS);
    long long max_buffer = extract_json_int(config_json, "maxBuffer", DEFAULT_MAX_BUFFER);
    long long max_processes = extract_json_int(config_json, "maxProcesses", 0);
    long long memory_limit_bytes = extract_json_int(config_json, "memoryLimitBytes", 0);
    long long cpu_rate_limit = extract_json_int(config_json, "cpuRateLimitPercent", 0);
    bool drop_admin = extract_json_bool(config_json, "dropAdminPrivileges", false);
    bool restricted_token_enabled = extract_json_bool(config_json, "restrictedTokenEnabled", false);
    bool stream_output = force_stream || extract_json_bool(config_json, "streamOutput", false);

    bool appcontainer_enabled = extract_json_bool(config_json, "appContainerEnabled", false);
    char *appcontainer_name = extract_json_string(config_json, "appContainerName");
    bool network_allow = extract_json_bool(config_json, "networkAllow", false);

    char **allowed_read_paths = NULL;
    int allowed_read_path_count = extract_json_string_array(config_json, "allowedReadPaths", &allowed_read_paths);
    char **allowed_write_paths = NULL;
    int allowed_write_path_count = extract_json_string_array(config_json, "allowedWritePaths", &allowed_write_paths);

    /* 构建完全隔离的环境变量块 */
    wchar_t *env_block = build_unicode_env_block(config_json);

    int ret = run_sandbox_internal(
        command,
        args,
        arg_count,
        cwd,
        timeout_ms,
        max_buffer,
        max_processes,
        memory_limit_bytes,
        cpu_rate_limit,
        drop_admin,
        restricted_token_enabled,
        stream_output,
        env_block,
        appcontainer_enabled,
        appcontainer_name,
        network_allow,
        allowed_read_paths,
        allowed_read_path_count,
        allowed_write_paths,
        allowed_write_path_count
    );

    if (env_block) free(env_block);

    free(command);
    if (cwd) free(cwd);
    if (appcontainer_name) free(appcontainer_name);
    if (args) {
        for (int i = 0; i < arg_count; i++) free(args[i]);
        free(args);
    }
    if (allowed_read_paths) {
        for (int i = 0; i < allowed_read_path_count; i++) free(allowed_read_paths[i]);
        free(allowed_read_paths);
    }
    if (allowed_write_paths) {
        for (int i = 0; i < allowed_write_path_count; i++) free(allowed_write_paths[i]);
        free(allowed_write_paths);
    }

    return ret;
}

int main(int argc, char *argv[]) {
    if (argc < 2) {
        fprintf(stderr, "Usage: nash-windows-sandbox-helper --version-json | --config-json <json> | --config-file <path> | --cleanup-profile <name> | --revoke-acl <sid> <path> | [--stream] -- <cmd> [args...]\n");
        return 1;
    }

    if (strcmp(argv[1], "--version-json") == 0) {
        print_version_json();
        return 0;
    }

    if (strcmp(argv[1], "--process-identity") == 0 && argc >= 3) {
        DWORD pid = (DWORD)strtoul(argv[2], NULL, 10);
        HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
        if (!process) return 1;
        FILETIME created, exited, kernel, user;
        BOOL ok = GetProcessTimes(process, &created, &exited, &kernel, &user);
        CloseHandle(process);
        if (!ok) return 1;
        printf("%08lx%08lx\n", created.dwHighDateTime, created.dwLowDateTime);
        return 0;
    }
    if (strcmp(argv[1], "--profile-sid") == 0 && argc >= 3) {
        wchar_t *name = utf8_to_wide(argv[2]);
        PSID sid = NULL;
        HRESULT hr = DeriveAppContainerSidFromAppContainerName(name, &sid);
        free(name);
        if (FAILED(hr)) return 1;
        LPWSTR text = NULL;
        BOOL ok = ConvertSidToStringSidW(sid, &text);
        if (ok) wprintf(L"%ls\n", text);
        if (text) LocalFree(text);
        FreeSid(sid);
        return ok ? 0 : 1;
    }

    if (strcmp(argv[1], "--cleanup-json") == 0 && argc >= 3) {
        char *sidText = extract_json_string(argv[2], "sid");
        char *profile = extract_json_string(argv[2], "profileName");
        wchar_t *wSid = sidText ? utf8_to_wide(sidText) : NULL;
        PSID sid = NULL;
        bool ok = wSid && ConvertStringSidToSidW(wSid, &sid);
        for (int group = 0; group < 3; group++) {
            char **paths = NULL;
            int count = extract_json_string_array(argv[2], group == 2 ? "allowedTraversePaths" : group ? "allowedWritePaths" : "allowedReadPaths", &paths);
            for (int i = 0; i < count; i++) {
                wchar_t *target = utf8_to_wide(paths[i]);
                if (!target) ok = false;
                else if (GetFileAttributesW(target) != INVALID_FILE_ATTRIBUTES) {
                    if (!sid || !revoke_appcontainer_access(target, sid)) ok = false;
                } else if (GetLastError() != ERROR_FILE_NOT_FOUND && GetLastError() != ERROR_PATH_NOT_FOUND) ok = false;
                if (target) free(target);
                free(paths[i]);
            }
            if (paths) free(paths);
        }
        if (profile) {
            wchar_t *name = utf8_to_wide(profile);
            HRESULT hr = E_FAIL;
            if (name) {
                for (int attempt = 0; attempt < 10; attempt++) {
                    hr = DeleteAppContainerProfile(name);
                    if (SUCCEEDED(hr) || hr == HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND)) break;
                    Sleep(50);
                }
            } else {
                hr = E_INVALIDARG;
            }
            if (FAILED(hr) && hr != HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND)) ok = false;
            if (name) free(name);
        } else ok = false;
        if (sid) LocalFree(sid);
        if (wSid) free(wSid);
        if (sidText) free(sidText);
        if (profile) free(profile);
        printf("{\"cleaned\":%s}\n", ok ? "true" : "false");
        return ok ? 0 : 1;
    }

    /* 独立 Profile 销毁接口 (供崩溃恢复账本调用) */
    if (strcmp(argv[1], "--cleanup-profile") == 0 && argc >= 3) {
        wchar_t *wProfileName = utf8_to_wide(argv[2]);
        if (wProfileName) {
            HRESULT hr = E_FAIL;
            for (int attempt = 0; attempt < 10; attempt++) {
                hr = DeleteAppContainerProfile(wProfileName);
                if (SUCCEEDED(hr) || hr == HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND)) break;
                Sleep(50);
            }
            free(wProfileName);
            printf("{\"profile\":\"%s\",\"deleted\":%s,\"code\":\"0x%08X\"}\n",
                   argv[2], (SUCCEEDED(hr) || hr == HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND)) ? "true" : "false", (unsigned int)hr);
            return (SUCCEEDED(hr) || hr == HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND)) ? 0 : 1;
        }
        return 1;
    }

    /* 独立 ACE 撤销接口 (供崩溃恢复账本调用) */
    if (strcmp(argv[1], "--revoke-acl") == 0 && argc >= 4) {
        const char *sidStr = argv[2];
        const char *pathStr = argv[3];
        wchar_t *wSid = utf8_to_wide(sidStr);
        wchar_t *wPath = utf8_to_wide(pathStr);
        bool success = false;
        if (wSid && wPath) {
            PSID pSid = NULL;
            if (ConvertStringSidToSidW(wSid, &pSid) && pSid) {
                success = revoke_appcontainer_access(wPath, pSid);
                LocalFree(pSid);
            }
        }
        if (wSid) free(wSid);
        if (wPath) free(wPath);
        printf("{\"path\":\"%s\",\"revoked\":%s}\n", pathStr, success ? "true" : "false");
        return success ? 0 : 1;
    }

    bool stream_mode = false;
    int arg_offset = 1;

    if (strcmp(argv[1], "--stream") == 0) {
        stream_mode = true;
        arg_offset = 2;
        if (argc < 3) {
            fprintf(stderr, "Missing target after --stream\n");
            return 1;
        }
    }

    if (strcmp(argv[arg_offset], "--config-json") == 0 && argc >= arg_offset + 2) {
        return run_sandbox_from_json(argv[arg_offset + 1], stream_mode);
    }

    if (strcmp(argv[arg_offset], "--config-file") == 0 && argc >= arg_offset + 2) {
        FILE *fp = fopen(argv[arg_offset + 1], "rb");
        if (!fp) {
            fprintf(stderr, "Failed to open config file: %s\n", argv[arg_offset + 1]);
            return 1;
        }
        fseek(fp, 0, SEEK_END);
        long size = ftell(fp);
        fseek(fp, 0, SEEK_SET);
        char *content = (char *)malloc(size + 1);
        if (!content) {
            fclose(fp);
            return 1;
        }
        fread(content, 1, size, fp);
        content[size] = '\0';
        fclose(fp);

        int ret = run_sandbox_from_json(content, stream_mode);
        free(content);
        return ret;
    }

    /* 直接命令行包装器模式: nash-windows-sandbox-helper.exe [--stream] -- <command> [args...] */
    if (strcmp(argv[arg_offset], "--") == 0 && argc > arg_offset + 1) {
        const char *target_cmd = argv[arg_offset + 1];
        char **target_args = NULL;
        int target_arg_count = argc - (arg_offset + 2);
        if (target_arg_count > 0) {
            target_args = &argv[arg_offset + 2];
        }

        return run_sandbox_internal(
            target_cmd,
            target_args,
            target_arg_count,
            NULL, // cwd
            DEFAULT_TIMEOUT_MS,
            DEFAULT_MAX_BUFFER,
            0, // max_processes
            0, // memory_limit
            0, // cpu_rate_limit
            false, // drop_admin
            false, // restricted_token
            true,  // stream_output
            NULL,  // env_block
            false, // appcontainer_enabled
            NULL,  // appcontainer_name
            true,  // network_allow
            NULL, 0,
            NULL, 0
        );
    }

    fprintf(stderr, "Unknown option: %s\n", argv[1]);
    return 1;
}

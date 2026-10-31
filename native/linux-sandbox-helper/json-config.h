#ifndef NASH_JSON_CONFIG_H
#define NASH_JSON_CONFIG_H
#include <ctype.h>
#include <limits.h>
#include <stdint.h>

static int json_config_error = 0;
static const char *json_ws(const char *p) { while (*p && isspace((unsigned char)*p)) p++; return p; }
static int json_hex4(const char *p, uint32_t *out) {
    *out = 0;
    for (int i = 0; i < 4; i++) {
        unsigned char c = (unsigned char)p[i];
        if (!c || !isxdigit(c)) return 0;
        *out = *out * 16 + (c <= '9' ? c - '0' : (c | 32) - 'a' + 10);
    }
    return 1;
}
static char *json_string(const char **cursor) {
    const char *p = *cursor;
    if (*p++ != '"') return NULL;
    char *result = malloc(strlen(p) + 1);
    if (!result) return NULL;
    size_t w = 0;
    while (*p && *p != '"') {
        unsigned char c = (unsigned char)*p++;
        if (c < 32) goto invalid;
        if (c != '\\') { result[w++] = (char)c; continue; }
        c = (unsigned char)*p++;
        switch (c) {
            case '"': case '\\': case '/': result[w++] = (char)c; break;
            case 'b': result[w++] = '\b'; break;
            case 'f': result[w++] = '\f'; break;
            case 'n': result[w++] = '\n'; break;
            case 'r': result[w++] = '\r'; break;
            case 't': result[w++] = '\t'; break;
            case 'u': {
                uint32_t code;
                if (!json_hex4(p, &code)) goto invalid;
                p += 4;
                if (code >= 0xd800 && code <= 0xdbff) {
                    uint32_t low;
                    if (p[0] != '\\' || p[1] != 'u' || !json_hex4(p + 2, &low) || low < 0xdc00 || low > 0xdfff) goto invalid;
                    p += 6;
                    code = 0x10000 + ((code - 0xd800) << 10) + low - 0xdc00;
                } else if (code >= 0xdc00 && code <= 0xdfff) goto invalid;
                if (!code) goto invalid; /* exec paths and argv cannot contain embedded NUL. */
                if (code < 0x80) result[w++] = (char)code;
                else if (code < 0x800) { result[w++] = (char)(0xc0 | (code >> 6)); result[w++] = (char)(0x80 | (code & 63)); }
                else if (code < 0x10000) { result[w++] = (char)(0xe0 | (code >> 12)); result[w++] = (char)(0x80 | ((code >> 6) & 63)); result[w++] = (char)(0x80 | (code & 63)); }
                else { result[w++] = (char)(0xf0 | (code >> 18)); result[w++] = (char)(0x80 | ((code >> 12) & 63)); result[w++] = (char)(0x80 | ((code >> 6) & 63)); result[w++] = (char)(0x80 | (code & 63)); }
                break;
            }
            default: goto invalid;
        }
    }
    if (*p != '"') goto invalid;
    result[w] = '\0'; *cursor = p + 1; return result;
invalid:
    free(result); return NULL;
}
static const char *json_value_end(const char *p, int depth) {
    if (depth > 64) return NULL;
    p = json_ws(p);
    if (*p == '"') { char *s = json_string(&p); if (!s) return NULL; free(s); return p; }
    if (*p == '{' || *p == '[') {
        int object = *p == '{'; char close = object ? '}' : ']'; p = json_ws(p + 1);
        if (*p == close) return p + 1;
        while (*p) {
            if (object) {
                char *key = json_string(&p); if (!key) return NULL; free(key);
                p = json_ws(p); if (*p++ != ':') return NULL;
            }
            p = json_value_end(p, depth + 1); if (!p) return NULL;
            p = json_ws(p); if (*p == close) return p + 1;
            if (*p++ != ',') return NULL;
            p = json_ws(p);
        }
        return NULL;
    }
    if (!strncmp(p, "true", 4)) return p + 4;
    if (!strncmp(p, "false", 5)) return p + 5;
    if (!strncmp(p, "null", 4)) return p + 4;
    if (*p == '-') p++;
    if (*p == '0') p++;
    else { if (*p < '1' || *p > '9') return NULL; while (isdigit((unsigned char)*p)) p++; }
    if (*p == '.') { p++; if (!isdigit((unsigned char)*p)) return NULL; while (isdigit((unsigned char)*p)) p++; }
    if (*p == 'e' || *p == 'E') { p++; if (*p == '+' || *p == '-') p++; if (!isdigit((unsigned char)*p)) return NULL; while (isdigit((unsigned char)*p)) p++; }
    return p;
}
static const char *find_toplevel_key(const char *json, const char *key) {
    const char *p = json_ws(json), *found = NULL;
    if (*p++ != '{') { json_config_error = 1; return NULL; }
    p = json_ws(p);
    while (*p && *p != '}') {
        char *name = json_string(&p);
        if (!name) { json_config_error = 1; return NULL; }
        p = json_ws(p);
        if (*p++ != ':') { free(name); json_config_error = 1; return NULL; }
        p = json_ws(p);
        if (!strcmp(name, key)) {
            if (found) { free(name); json_config_error = 1; return NULL; }
            found = p;
        }
        free(name);
        p = json_value_end(p, 1);
        if (!p) { json_config_error = 1; return NULL; }
        p = json_ws(p);
        if (*p == '}') break;
        if (*p++ != ',') { json_config_error = 1; return NULL; }
        p = json_ws(p);
    }
    return found;
}
static char *extract_json_string_field(const char *json, const char *key) {
    const char *p = find_toplevel_key(json, key);
    if (!p) return NULL;
    char *value = json_string(&p);
    if (!value) json_config_error = 1;
    return value;
}
static int extract_json_int_field(const char *json, const char *key, int fallback) {
    const char *p = find_toplevel_key(json, key);
    if (!p) return fallback;
    char *end; errno = 0; long value = strtol(p, &end, 10);
    if (end == p || errno || value < INT_MIN || value > INT_MAX || (*json_ws(end) != ',' && *json_ws(end) != '}')) { json_config_error = 1; return fallback; }
    return (int)value;
}
static int extract_json_bool_field(const char *json, const char *key, int fallback) {
    const char *p = find_toplevel_key(json, key);
    if (!p) return fallback;
    if (!strncmp(p, "true", 4)) return 1;
    if (!strncmp(p, "false", 5)) return 0;
    json_config_error = 1; return fallback;
}
static int extract_json_string_array(const char *json, const char *key, char ***out_items, int *out_count) {
    *out_items = NULL; *out_count = 0;
    const char *p = find_toplevel_key(json, key);
    if (!p) return 0;
    if (*p++ != '[') { json_config_error = 1; return -1; }
    p = json_ws(p);
    while (*p && *p != ']') {
        char *item = json_string(&p);
        if (!item) { json_config_error = 1; return -1; }
        char **items = realloc(*out_items, sizeof(char *) * (size_t)(*out_count + 1));
        if (!items) { free(item); json_config_error = 1; return -1; }
        *out_items = items; items[(*out_count)++] = item;
        p = json_ws(p); if (*p == ']') break;
        if (*p++ != ',') { json_config_error = 1; return -1; }
        p = json_ws(p);
    }
    return 0;
}
#endif

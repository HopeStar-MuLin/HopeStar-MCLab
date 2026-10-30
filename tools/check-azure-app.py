#!/usr/bin/env python3
"""检查一个 Azure 应用是不是配好了「微软登录」需要的东西。

启动器走的是设备码流程（GrantFlow.DEVICE），所以真正要满足的条件只有三条：

1. app id 存在，且在 **consumers** 租户下可用（必须是「个人 Microsoft 账户」类型）；
2. 允许公共客户端流（`allowPublicClient = true`），否则会 `AADSTS70002`；
3. 申请的 scope `XboxLive.signin offline_access` 被接受。

这个脚本直接打设备码接口，能拿到 user_code 就说明前三条都过了；
Mojang 审核是另一件事，不在这三条里（拿得到 user_code 也可能在 XBL 那步被拒）。

用法：
    python tools/check-azure-app.py <client_id>
"""
from __future__ import annotations

import json
import sys
import urllib.parse
import urllib.request

URL = "https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode"
SCOPE = "XboxLive.signin offline_access"

HINTS = {
    "70002": [
        "应用没被标记成公共客户端（mobile）。",
        "去 应用注册 → 你的应用 → 身份验证 → 拉到底「高级设置」→ 允许公共客户端流 = 是。",
        "找不到就用清单兜底：清单 → \"allowPublicClient\": true → 保存。",
    ],
    "700016": [
        "找不到这个 app id：确认复制的是「应用程序(客户端) ID」，不是对象 ID；",
        "也确认应用没被删掉、没有登录到别的租户。",
    ],
    "90002": [
        "租户类型不对：应用必须是「仅个人 Microsoft 账户」（consumers），",
        "企业/学校账户走这条路会失败。",
    ],
    "65001": [
        "权限没 consented：检查 scope 是否被应用允许（XboxLive.signin offline_access）。",
    ],
}


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    client_id = sys.argv[1].strip()

    body = urllib.parse.urlencode({"client_id": client_id, "scope": SCOPE}).encode()
    req = urllib.request.Request(URL, data=body, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        data = json.loads(e.read().decode("utf-8"))
    except Exception as e:  # 网络问题
        print(f"[x] 请求失败：{e}")
        return 2

    if data.get("user_code"):
        print("[ok] 应用配置可用。")
        print(f"     user_code = {data['user_code']}（这条只是为了验证，不用真去登录）")
        print(f"     有效期 {data.get('expires_in', '?')} 秒，忽略即可")
        print("[i] 下一步：把这个 app id 提交 Mojang 审核 https://aka.ms/mce-reviewappid")
        print("    审核通过前，登录会在 Xbox Live 认证那一步失败。")
        return 0

    code = str((data.get("error_codes") or [""])[0])
    print(f"[x] {data.get('error')}: {data.get('error_description', '').split(' Trace ID')[0]}")
    for line in HINTS.get(code, ["对照 docs/microsoft-login.md 逐条检查。"]):
        print("    - " + line)
    return 1


if __name__ == "__main__":
    sys.exit(main())

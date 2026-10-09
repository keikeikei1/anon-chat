#!/usr/bin/env python3
"""验证新功能上线 + 试跑 AI 审核（拿最新一条举报记录）"""
import json, os, re, time, urllib.request, urllib.parse

KEY = os.environ.get('ADMIN_KEY', 'CHANGE_ME_random_admin_key')
BASE = os.environ.get('BASE', 'https://anon-chat.example.workers.dev')
UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36')

def get(path, tries=6, as_json=True):
    req = urllib.request.Request(BASE + path, headers={'User-Agent': UA})
    for i in range(tries):
        try:
            raw = urllib.request.urlopen(req, timeout=25).read().decode()
            return json.loads(raw) if as_json else raw
        except Exception as e:
            print('  尝试%d失败: %s' % (i + 1, type(e).__name__)); time.sleep(4)
    return None

page = get('/', as_json=False) or ''
print('=== 新功能是否在线上 ===')
for kw in ['正在加载最近的聊天记录', '秒后自动重连', 'anonchat:age', 'AI 审核', '只看未处理']:
    print('  %-22s %s' % (kw, '✅' if kw in page else '❌'))

print()
print('=== 试跑 AI 审核 ===')
d = get('/admin/data?key=' + KEY)
if not d or not d.get('reports'):
    print('  没有举报记录可测')
else:
    k = d['reports'][0]['key']
    print('  目标记录:', k)
    t0 = time.time()
    r = get('/admin/ai?key=%s&k=%s' % (KEY, urllib.parse.quote(k)), tries=3)
    print('  耗时: %.1f 秒' % (time.time() - t0))
    if r is None:
        print('  调用失败（网络）')
    elif not r.get('ok'):
        print('  服务端返回失败:', r.get('error'))
    else:
        print('  结论:', json.dumps(r.get('parsed'), ensure_ascii=False) if r.get('parsed') else '(未解析出 JSON)')
        print('  原文:', (r.get('verdict') or '')[:220])

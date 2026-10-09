#!/usr/bin/env python3
"""验证给机器人用的审核 API：读待审 + 批复 + 审计留痕"""
import json, os, re, time, urllib.request, urllib.parse

KEY = os.environ.get('ADMIN_KEY', 'CHANGE_ME_random_admin_key')
BASE = os.environ.get('BASE', 'https://anon-chat.example.workers.dev')
UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36')

def get(path, tries=5):
    req = urllib.request.Request(BASE + path, headers={'User-Agent': UA})
    for i in range(tries):
        try:
            return json.loads(urllib.request.urlopen(req, timeout=25).read().decode())
        except Exception as e:
            print('  尝试%d: %s' % (i + 1, type(e).__name__)); time.sleep(4)
    return None

print('① 无 key 访问应 403')
req = urllib.request.Request(BASE + '/api/pending', headers={'User-Agent': UA})
try:
    urllib.request.urlopen(req, timeout=20); print('   异常：居然放行了')
except Exception as e:
    print('   ->', type(e).__name__, e)

print('② 读待审列表')
d = get('/api/pending?key=' + KEY)
if not d or not d.get('ok'):
    print('   失败:', d)
else:
    print('   待审 %d 条 / 最近返回 %d 条' % (d['pending_total'], d['count']))
    if d['items']:
        it = d['items'][0]
        print('   首条: key=%s mode=%s 被举报消息=%s' % (it['key'], it['mode'], (it.get('reported_msg') or {}).get('v', '(无)')[:30]))

print('③ 用 action=ignore 批复第一条（模拟机器人）')
if d and d.get('items'):
    k = d['items'][0]['key']
    r = get('/api/action?key=%s&action=ignore&k=%s&by=hermes-bot' % (KEY, urllib.parse.quote(k)))
    print('   ->', json.dumps(r, ensure_ascii=False)[:200] if r else '失败')
    print('④ 复读该条，确认 handled 与我方留痕')
    d2 = get('/api/pending?key=%s&status=all' % KEY)
    hit = [x for x in (d2 or {}).get('items', []) if x['key'] == k]
    print('   ->', json.dumps(hit[0] if hit else '未找到', ensure_ascii=False)[:200])

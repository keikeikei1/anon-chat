#!/usr/bin/env python3
"""Read the admin stats endpoint (browser UA is required: Cloudflare's
Browser Integrity Check rejects non-browser user agents)."""
import json, os, time, urllib.request

KEY = os.environ.get('ADMIN_KEY', 'CHANGE_ME_random_admin_key')
BASE = os.environ.get('BASE', 'https://anon-chat.example.workers.dev')
UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36')

req = urllib.request.Request(BASE + '/admin/data?key=' + KEY, headers={'User-Agent': UA})
for i in range(3):
    try:
        d = json.loads(urllib.request.urlopen(req, timeout=20).read().decode())
        print('hall:', d['hall'], '| queue:', d['queue'], '| conns:', d['conns'],
              '| retention_days:', d['retention_days'])
        print('reports:', len(d['reports']), '| bans:', len(d.get('bans', [])))
        break
    except Exception as e:
        print('try %d failed: %s' % (i + 1, e))
        time.sleep(3)

// lib/automation/handlers/rules-index.js
import { kv } from '../../kv.js';
import { buildRule } from '../rule-schema.js';

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const ids = await kv.lrange('automation:rules:index', 0, -1);
    if (!ids.length) return res.status(200).json([]);
    const rules = await Promise.all(ids.map(id => kv.get(`automation:rule:${id}`)));
    return res.status(200).json(rules.filter(Boolean).reverse());
  }

  if (req.method === 'POST') {
    let rule;
    try {
      rule = buildRule(req.body);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    await kv.set(`automation:rule:${rule.id}`, rule);
    await kv.lpush('automation:rules:index', rule.id);
    return res.status(201).json(rule);
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

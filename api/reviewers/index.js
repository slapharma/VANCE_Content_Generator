import { kv } from '../../lib/kv.js';
import { randomUUID } from 'crypto';

export function validateReviewer(data) {
  if (!data.email) throw new Error('email is required');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) throw new Error('email is invalid');
}

export function buildReviewer(data) {
  return { id: randomUUID(), name: data.name ?? data.email, email: data.email, role: data.role ?? 'must_approve' };
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const reviewers = await kv.get('reviewers') ?? [];
    return res.json(reviewers);
  }
  if (req.method === 'POST') {
    try { validateReviewer(req.body); } catch (e) { return res.status(400).json({ error: e.message }); }
    const reviewer = buildReviewer(req.body);
    const reviewers = await kv.get('reviewers') ?? [];
    reviewers.push(reviewer);
    await kv.set('reviewers', reviewers);
    return res.status(201).json(reviewer);
  }
  if (req.method === 'PATCH') {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'id is required' });
    const reviewers = await kv.get('reviewers') ?? [];
    const idx = reviewers.findIndex(r => r.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Reviewer not found' });
    if (req.body.role !== undefined) reviewers[idx].role = req.body.role;
    if (req.body.name !== undefined) reviewers[idx].name = req.body.name;
    if (req.body.email !== undefined) {
      const newEmail = req.body.email;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) return res.status(400).json({ error: 'email is invalid' });
      reviewers[idx].email = newEmail;
    }
    await kv.set('reviewers', reviewers);
    return res.json(reviewers[idx]);
  }
  if (req.method === 'DELETE') {
    const { id } = req.query;
    const reviewers = (await kv.get('reviewers') ?? []).filter(r => r.id !== id);
    await kv.set('reviewers', reviewers);
    return res.status(204).end();
  }
  res.status(405).json({ error: 'Method not allowed' });
}

// lib/social/handlers/design-templates.js
//
//   GET    /api/social/design-templates        built-ins first, then custom
//   POST   /api/social/design-templates        create
//   GET    /api/social/design-templates/:id    one template
//   PATCH  /api/social/design-templates/:id    edit (custom only)
//   DELETE /api/social/design-templates/:id    remove (custom only)
//
// Built-ins are read-only by construction: they are derived from STYLES rather
// than stored, so there is nothing to write to. The handler says so explicitly
// instead of 404ing, because "Education cannot be edited" is a useful answer and
// "not found" is a confusing one for something the picker just showed you.

import {
  buildTemplate, saveTemplate, getTemplate, listTemplates, deleteTemplate,
  builtInTemplates, BASE_STYLES,
} from '../design-templates.js';

const isBuiltIn = (id) => builtInTemplates().some((t) => t.id === id);

export default async function handler(req, res, { id } = {}) {
  if (!id) {
    if (req.method === 'GET') {
      return res.status(200).json({ templates: await listTemplates(), baseStyles: BASE_STYLES });
    }
    if (req.method === 'POST') {
      const template = buildTemplate(req.body || {});
      return res.status(201).json(await saveTemplate(template, { indexIt: true }));
    }
    return res.status(405).end();
  }

  if (req.method === 'GET') {
    const template = await getTemplate(id);
    return template
      ? res.status(200).json(template)
      : res.status(404).json({ error: `No template ${id}` });
  }

  if (req.method === 'PATCH') {
    if (isBuiltIn(id)) {
      return res.status(400).json({
        error: 'Built-in templates cannot be edited. Duplicate it into a new template instead.',
      });
    }
    const existing = await getTemplate(id);
    if (!existing) return res.status(404).json({ error: `No template ${id}` });
    return res.status(200).json(await saveTemplate(buildTemplate(req.body || {}, existing)));
  }

  if (req.method === 'DELETE') {
    if (isBuiltIn(id)) {
      return res.status(400).json({ error: 'Built-in templates cannot be deleted.' });
    }
    try {
      const ok = await deleteTemplate(id);
      // Campaigns pointing at a deleted template keep running: resolveTemplateForDeck
      // falls back to the promotional style rather than failing their next occurrence.
      return res.status(ok ? 200 : 404).json(ok
        ? { id, deleted: true, note: 'Campaigns using it fall back to the Promotional template' }
        : { error: `No template ${id}` });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }

  return res.status(405).end();
}

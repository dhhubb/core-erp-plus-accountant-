'use client';

import { useCallback, useEffect, useState } from 'react';
import { adminDelete, adminGet, adminPatch, adminPost } from '@/verticals/admin/client';
import type { CategoryNode } from '@/verticals/admin/types';

/**
 * /admin/categories — the category tree.
 *
 * The tree nests through parent_id and is rendered depth-first (the SQL orders it). Create, rename
 * and delete all go through the admin routes; the server refuses a delete while a category has
 * children or products, and refuses a move under its own descendant.
 */

interface CategoryFormState {
  id: string | null;
  name: string;
  slug: string;
  parentId: string | null;
}

const EMPTY_FORM: CategoryFormState = { id: null, name: '', slug: '', parentId: null };

export default function CategoriesPage() {
  const [tree, setTree] = useState<CategoryNode[]>([]);
  const [form, setForm] = useState<CategoryFormState>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = await adminGet<{ categories: CategoryNode[] }>('/api/admin/categories');
      setTree(payload.categories);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = useCallback(async () => {
    setError(null);
    try {
      if (form.id) {
        await adminPatch(`/api/admin/categories/${form.id}`, {
          name: form.name,
          slug: form.slug,
          parent_id: form.parentId,
        });
      } else {
        await adminPost('/api/admin/categories', {
          name: form.name,
          slug: form.slug,
          parent_id: form.parentId,
        });
      }
      setForm(EMPTY_FORM);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }, [form, load]);

  const remove = useCallback(
    async (id: string) => {
      setError(null);
      try {
        await adminDelete(`/api/admin/categories/${id}`);
        await load();
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [load],
  );

  return (
    <main style={{ padding: 24, maxWidth: 960 }}>
      <h1>Categories</h1>

      {error && (
        <p role="alert" data-testid="categories-error" style={{ color: '#c0392b' }}>
          {error}
        </p>
      )}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '16px 0' }}
      >
        <input
          aria-label="Name"
          placeholder="Name"
          value={form.name}
          onChange={(event) => setForm({ ...form, name: event.target.value })}
        />
        <input
          aria-label="Slug"
          placeholder="Slug"
          value={form.slug}
          onChange={(event) => setForm({ ...form, slug: event.target.value })}
        />
        <select
          aria-label="Parent"
          value={form.parentId ?? ''}
          onChange={(event) => setForm({ ...form, parentId: event.target.value || null })}
        >
          <option value="">— no parent —</option>
          {tree
            .filter((node) => node.id !== form.id)
            .map((node) => (
              <option key={node.id} value={node.id}>
                {node.path}
              </option>
            ))}
        </select>
        <button type="submit" data-testid="category-submit">
          {form.id ? 'Save' : 'Add'}
        </button>
        {form.id && (
          <button type="button" onClick={() => setForm(EMPTY_FORM)}>
            Cancel
          </button>
        )}
      </form>

      {loading ? (
        <p>Loading…</p>
      ) : (
        <ul data-testid="category-tree" style={{ listStyle: 'none', paddingLeft: 0 }}>
          {tree.map((node) => (
            <li key={node.id} style={{ paddingLeft: node.depth * 20, padding: '4px 0' }}>
              <span data-testid="category-name">{node.name}</span>
              <code style={{ marginLeft: 8, color: '#666' }}>{node.slug}</code>
              <button
                type="button"
                style={{ marginLeft: 8 }}
                onClick={() => setForm({ id: node.id, name: node.name, slug: node.slug, parentId: node.parentId })}
              >
                Edit
              </button>
              <button
                type="button"
                style={{ marginLeft: 4 }}
                data-testid={`delete-${node.slug}`}
                onClick={() => void remove(node.id)}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

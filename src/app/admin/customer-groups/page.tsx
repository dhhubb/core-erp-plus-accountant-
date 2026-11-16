'use client';

import { useCallback, useEffect, useState } from 'react';
import { adminGet, adminPatch, adminPost, withCursor } from '@/verticals/admin/client';
import { PricingNav } from '@/verticals/admin/PricingNav';

/**
 * /admin/customer-groups — groups, each mapped to a price list (or the retail fallback), with the
 * members (contacts) that belong to them. A group is the link between a customer and a price list,
 * so the till resolves the wholesale list for a VIP and the retail list for everyone else.
 */

interface GroupRow {
  id: string;
  name: string;
  price_list_id: string | null;
  price_list_name: string | null;
  member_count: number;
  created_at: string;
}

interface GroupResponse {
  customer_groups: GroupRow[];
  next_cursor: { createdAt: string; id: string } | null;
}

interface PriceListRow {
  id: string;
  name: string;
  kind: string;
}

interface MemberRow {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
}

export default function CustomerGroupsPage() {
  const [rows, setRows] = useState<GroupRow[]>([]);
  const [cursor, setCursor] = useState<{ createdAt: string; id: string } | null>(null);
  const [priceLists, setPriceLists] = useState<PriceListRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [name, setName] = useState('');
  const [priceListId, setPriceListId] = useState<string>('');

  const [expanded, setExpanded] = useState<string | null>(null);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [assignId, setAssignId] = useState('');

  const loadPriceLists = useCallback(async () => {
    const payload = await adminGet<{ price_lists: PriceListRow[] }>('/api/admin/price-lists');
    setPriceLists(payload.price_lists);
  }, []);

  const loadFirstPage = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = await adminGet<GroupResponse>('/api/admin/customer-groups');
      setRows(payload.customer_groups);
      setCursor(payload.next_cursor);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPriceLists().catch((err: Error) => setError(err.message));
    void loadFirstPage();
  }, [loadPriceLists, loadFirstPage]);

  const loadMore = useCallback(async () => {
    if (!cursor) return;
    const payload = await adminGet<GroupResponse>(withCursor('/api/admin/customer-groups', cursor));
    setRows((current) => [...current, ...payload.customer_groups]);
    setCursor(payload.next_cursor);
  }, [cursor]);

  const create = useCallback(async () => {
    setError(null);
    try {
      await adminPost('/api/admin/customer-groups', {
        name,
        price_list_id: priceListId || null,
      });
      setName('');
      setPriceListId('');
      await loadFirstPage();
    } catch (err) {
      setError((err as Error).message);
    }
  }, [name, priceListId, loadFirstPage]);

  const remap = useCallback(
    async (id: string, nextPriceListId: string) => {
      setError(null);
      try {
        const row = rows.find((entry) => entry.id === id);
        await adminPatch(`/api/admin/customer-groups/${id}`, {
          name: row?.name ?? '',
          price_list_id: nextPriceListId || null,
        });
        await loadFirstPage();
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [rows, loadFirstPage],
  );

  const openMembers = useCallback(async (groupId: string) => {
    setExpanded(groupId);
    setMembers([]);
    try {
      const payload = await adminGet<{ members: MemberRow[] }>(
        `/api/admin/customer-groups/${groupId}/members`,
      );
      setMembers(payload.members);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const assign = useCallback(
    async (groupId: string, contactId: string) => {
      setError(null);
      setStatus(null);
      try {
        await adminPost(`/api/admin/customer-groups/${groupId}/members`, {
          contact_ids: [contactId],
        });
        setAssignId('');
        setStatus('Member assigned');
        await openMembers(groupId);
        await loadFirstPage();
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [openMembers, loadFirstPage],
  );

  return (
    <main style={{ padding: 24, maxWidth: 1100 }}>
      <h1>Customer groups</h1>
      <PricingNav current="/admin/customer-groups" />

      {error && (
        <p role="alert" data-testid="groups-error" style={{ color: '#c0392b' }}>
          {error}
        </p>
      )}
      {status && <p data-testid="groups-status">{status}</p>}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
        style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '12px 0' }}
      >
        <input
          aria-label="New group name"
          placeholder="Group name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <select
          aria-label="Group price list"
          value={priceListId}
          onChange={(event) => setPriceListId(event.target.value)}
        >
          <option value="">— retail (default) —</option>
          {priceLists.map((list) => (
            <option key={list.id} value={list.id}>
              {list.name} ({list.kind})
            </option>
          ))}
        </select>
        <button type="submit" data-testid="group-submit">
          Add group
        </button>
      </form>

      {loading ? (
        <p>Loading…</p>
      ) : (
        <table data-testid="group-table" style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr>
              <th align="left">Name</th>
              <th align="left">Price list</th>
              <th align="right">Members</th>
              <th align="left" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} data-testid={`group-${row.id}`}>
                <td>{row.name}</td>
                <td>
                  <select
                    aria-label={`Price list for ${row.name}`}
                    value={row.price_list_id ?? ''}
                    onChange={(event) => void remap(row.id, event.target.value)}
                  >
                    <option value="">— retail (default) —</option>
                    {priceLists.map((list) => (
                      <option key={list.id} value={list.id}>
                        {list.name} ({list.kind})
                      </option>
                    ))}
                  </select>
                </td>
                <td align="right">{row.member_count}</td>
                <td>
                  <button type="button" onClick={() => void openMembers(row.id)}>
                    Members
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {cursor && (
        <button type="button" onClick={() => void loadMore()} style={{ marginTop: 12 }}>
          Load more
        </button>
      )}

      {expanded && (
        <section style={{ marginTop: 24 }} data-testid="members-panel">
          <h2>Members</h2>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (assignId) void assign(expanded, assignId);
            }}
            style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '8px 0' }}
          >
            <input
              aria-label="Contact id to assign"
              placeholder="contact id"
              value={assignId}
              onChange={(event) => setAssignId(event.target.value)}
            />
            <button type="submit" data-testid="assign-member">
              Assign
            </button>
          </form>
          <ul>
            {members.map((member) => (
              <li key={member.id} data-testid={`member-${member.id}`}>
                {member.name} {member.email ? `— ${member.email}` : ''}
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

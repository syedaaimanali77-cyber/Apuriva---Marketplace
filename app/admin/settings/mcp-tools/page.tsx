'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Card, EmptyState, ErrorState, Skeleton, Table } from '@/components';
import type { TableColumn } from '@/components';
import type { McpToolMetadataDto } from '@/lib/types/mcp';
import styles from '../../admin.module.css';

interface ApiErrorBody {
  code: string;
  message: string;
}

type PageStatus = 'loading' | 'forbidden' | 'error' | 'ready';

/** Risk reads at a glance: the tiers that need a person's approval are the ones worth spotting. */
function riskTone(riskTier: McpToolMetadataDto['riskTier']): 'neutral' | 'warning' | 'error' {
  if (riskTier === 'high' || riskTier === 'restricted') return 'error';
  if (riskTier === 'medium') return 'warning';
  return 'neutral';
}

/**
 * Spec 035 §5, `app/admin/settings/mcp-tools` — the registry of MCP tools and what each may do.
 *
 * `GET /api/v1/admin/mcp/tools` is permission-scoped server-side (`mcp/read_registry`, Super Admin
 * only), so a caller without it gets a plain "you don't have access" state here — never a
 * client-side role check standing in for the real authorization spec 009 §5 requires.
 *
 * The empty state is the honest one for this phase: spec 035 registers no business tool, because
 * the read/action catalogue is spec 036's. Until then this table is empty by design, not broken.
 */
export default function AdminMcpToolsPage() {
  const [pageStatus, setPageStatus] = useState<PageStatus>('loading');
  const [pageError, setPageError] = useState<string | null>(null);
  const [tools, setTools] = useState<McpToolMetadataDto[]>([]);

  const load = useCallback(async () => {
    setPageStatus('loading');
    setPageError(null);
    const res = await fetch('/api/v1/admin/mcp/tools', { credentials: 'same-origin' });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = json as ApiErrorBody;
      if (error.code === 'FORBIDDEN') {
        setPageStatus('forbidden');
        return;
      }
      setPageStatus('error');
      setPageError(error.message ?? "Couldn't load the MCP tool registry.");
      return;
    }
    setTools((json.data as McpToolMetadataDto[]) ?? []);
    setPageStatus('ready');
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (pageStatus === 'loading') {
    return (
      <main className={styles.page} data-density="dense">
        <h1 className={styles.title}>MCP tools</h1>
        <Card>
          <Skeleton lines={6} />
        </Card>
      </main>
    );
  }

  if (pageStatus === 'forbidden') {
    return (
      <main className={styles.page} data-density="dense">
        <h1 className={styles.title}>MCP tools</h1>
        <Alert tone="warning" title="Additional permission required">
          The MCP tool registry is scoped to the Super Admin role — your account doesn&apos;t currently hold that
          permission.
        </Alert>
      </main>
    );
  }

  if (pageStatus === 'error') {
    return (
      <main className={styles.page} data-density="dense">
        <h1 className={styles.title}>MCP tools</h1>
        <ErrorState description={pageError ?? undefined} onRetry={load} />
      </main>
    );
  }

  if (tools.length === 0) {
    return (
      <main className={styles.page} data-density="dense">
        <h1 className={styles.title}>MCP tools</h1>
        <EmptyState
          icon="sparkles"
          title="No tools are registered yet"
          description="The authorization pipeline is in place; the tools themselves arrive with the tool catalogue. Until then the assistant can propose no actions."
        />
      </main>
    );
  }

  const columns: TableColumn<McpToolMetadataDto>[] = [
    { key: 'name', header: 'Tool', render: (row) => row.name },
    { key: 'label', header: 'Shown as', render: (row) => row.label },
    {
      key: 'riskTier',
      header: 'Risk',
      render: (row) => <Badge tone={riskTone(row.riskTier)}>{row.riskTier}</Badge>,
    },
    { key: 'requiresConfirmation', header: 'Confirmation', render: (row) => (row.requiresConfirmation ? 'Required' : 'None') },
    { key: 'reversible', header: 'Reversible', render: (row) => (row.reversible ? 'Yes' : 'No') },
    { key: 'modes', header: 'Modes', render: (row) => row.modes.join(', ') },
    { key: 'adminOnly', header: 'Surface', render: (row) => (row.adminOnly ? 'Admin only' : 'Conversation') },
  ];

  return (
    <main className={styles.page} data-density="dense">
      <h1 className={styles.title}>MCP tools</h1>
      <Card>
        <Table columns={columns} rows={tools} />
      </Card>
    </main>
  );
}

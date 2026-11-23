// Space rules as exceptions only: a badge appears only when a setting
// differs from the default — Review (approval, notify me, custom), a TTL, protected paths, archived. No badge for
// defaults and none for the viewer's own role.
import type { ReviewMode } from '../api/types';
import { REVIEW_LABEL } from '../lib/format';
import { Badge } from './ui';
import { tx } from '../i18n';

export interface SpaceRulesInput {
  review_mode: ReviewMode;
  executable: boolean;
  ttl_days?: number | null | undefined;
  protected_paths: string[];
  archived?: boolean;
}

export function SpaceBadges({ space }: { space: SpaceRulesInput }) {
  const ttl = space.ttl_days ?? null;
  const any = space.review_mode !== 'off' || space.executable || ttl !== null || space.protected_paths.length > 0 || space.archived;
  if (!any) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {space.review_mode !== 'off' && !space.executable && <Badge tone="warn">{REVIEW_LABEL[space.review_mode]}</Badge>}
      {space.executable && (
        <Badge title={tx.spaceBadges.notifyTitle} tone="warn">
          {space.review_mode === 'off' ? tx.spaceBadges.notify : tx.spaceBadges.custom}
        </Badge>
      )}
      {ttl !== null && <Badge>{tx.spaceBadges.ttl(ttl)}</Badge>}
      {space.protected_paths.length > 0 && <Badge title={space.protected_paths.join(', ')}>{tx.spaceBadges.protected(space.protected_paths.join(', '))}</Badge>}
      {space.archived && <Badge tone="danger">{tx.common.inArchive}</Badge>}
    </div>
  );
}

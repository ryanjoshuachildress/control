import { getImmichOrigin } from '../user';

// One attachment: clickable thumbnail for photos, inline player for videos.
// Immich-linked assets stream through /api/immich and deep-link into Immich.
export function Media({ a, alt }) {
  if (a.immich) {
    const open = `${getImmichOrigin() || ''}/photos/${a.asset_id}`;
    if (a.media === 'video') {
      return (
        <span className="att">
          <video className="pf-video" src={`/api/immich/asset/${a.asset_id}/original`} controls preload="metadata" />
          <div className="tiny"><a href={open} target="_blank" rel="noopener">↗ open in Immich</a></div>
        </span>
      );
    }
    return (
      <a className="pf-thumb-link" href={open} target="_blank" rel="noopener" title="Open in Immich">
        <img className="pf-thumb" src={`/api/immich/asset/${a.asset_id}/thumb`} alt={alt || 'Immich photo'} />
      </a>
    );
  }
  const url = `/uploads/${a.path}`;
  if (a.media === 'video' || /\.(mp4|webm|mov|m4v)$/i.test(a.path)) {
    return <video className="pf-video" src={url} controls preload="metadata" />;
  }
  return (
    <a className="pf-thumb-link" href={url} target="_blank" rel="noopener">
      <img className="pf-thumb" src={url} alt={alt || 'Attachment'} />
    </a>
  );
}

export function FeedMedia({ attachments, alt, renderExtra }) {
  return (
    <div className="feed-media">
      {(attachments || []).map((a, i) => <Media key={i} a={a} alt={alt} />)}
      {renderExtra}
    </div>
  );
}
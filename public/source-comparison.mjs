export function sourceComparisonContext(project, episodeNumber, mark, index, markCount) {
  const shots = (project.shots || []).filter(shot => (shot.data.episodeNumber ?? 1) === episodeNumber).sort((a, b) => a.order - b.order);
  const shot = (mark.shotCode ? shots.find(shot => shot.code === mark.shotCode) : shots.length === markCount ? shots[index] : null) || null;
  if (!shot) return { shot, images: [] };
  const ids = new Set(shots.map(shot => shot.id));
  const boards = (project.storyboards || []).filter(board => board.data.shotIds.includes(shot.id) && board.data.shotIds.every(id => ids.has(id)));
  const images = [], seen = new Set();
  for (const entity of [shot, ...boards]) {
    for (const media of entity.media || []) {
      if (media.kind !== 'image' || seen.has(media.id)) continue;
      seen.add(media.id);
      images.push({ ...media, entityName: entity.name });
    }
  }
  return { shot, images };
}

export function sourceComparisonFor(mark, seconds) {
  return mark.comparisons?.find(entry => entry.time === String(seconds)) || null;
}

export function sourceComparisonTitle(mark, shot, index) {
  return mark.title || shot?.name || `镜头 ${index + 1}`;
}

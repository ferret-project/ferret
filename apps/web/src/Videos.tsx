/**
 * How-to videos on maintenance tasks (server: lib/videos.ts). `VideoChips` under a task (its row, the Done dialog) play
 * them in `VideoPlayer` — YouTube's privacy-enhanced player inside Ferret, with Close (so an iPhone's Home Screen app
 * never strands you on YouTube). `TaskVideos` in the task's dialog adds them — search YouTube from Ferret when the
 * server has a YouTube key, else YouTube's own search in a new tab — or paste a link; and removes them.
 */
import type { MaintenanceTask, TaskVideo, VideoHit } from "@ferret/shared";
import { videoLength, youtubeEmbedUrl, youtubeId, youtubeSearchUrl, youtubeThumbnail, youtubeWatchUrl } from "@ferret/shared/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { t, ph } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { api } from "./lib/api";
import { useFeatures } from "./lib/features";

type Playable = Pick<TaskVideo, "videoId" | "title" | "channel">;

/** A task's videos as small thumbnails with their titles; tap to play. */
export function VideoChips({ videos }: { videos: TaskVideo[] }) {
  const [playing, setPlaying] = useState<Playable | null>(null);
  if (!videos.length) return null;
  return (
    <>
      <ul className="flex flex-wrap gap-2" aria-label={t`How-to videos`}>
        {videos.map((v) => (
          <li key={v.id} className="min-w-0 max-w-full">
            <button type="button" className="flex max-w-72 items-center gap-2 rounded-field bg-base-200 p-1 pe-3 text-start hover:bg-base-300" onClick={() => setPlaying(v)}>
              <Thumb videoId={v.videoId} className="h-9 w-16" />
              <span className="min-w-0 truncate text-xs text-base-content/80">{v.title ?? t`YouTube video`}</span>
            </button>
          </li>
        ))}
      </ul>
      {playing && <VideoPlayer video={playing} onClose={() => setPlaying(null)} />}
    </>
  );
}

function Thumb({ videoId, className = "" }: { videoId: string; className?: string }) {
  return (
    <span className={`relative shrink-0 overflow-hidden rounded-sm bg-black ${className}`}>
      <img src={youtubeThumbnail(videoId)} alt="" loading="lazy" className="size-full object-cover" />
      <span className="absolute inset-0 flex items-center justify-center" aria-hidden>
        <span className="icon-[tabler--player-play-filled] size-4 text-white drop-shadow" />
      </span>
    </span>
  );
}

/** The video full screen in YouTube's privacy-enhanced player. Esc or Close closes. */
export function VideoPlayer({ video, onClose }: { video: Playable; onClose: () => void }) {
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    closeButton.current?.focus();
    // Before the dialog under it hears the Esc.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = overflow;
      before?.focus();
    };
  }, [onClose]);
  const title = video.title ?? t`YouTube video`;
  return createPortal(
    <div className="fixed inset-0 z-[100] flex flex-col bg-black text-white" role="dialog" aria-modal="true" aria-label={title}>
      <div className="flex items-center gap-1 p-2 ps-3 pt-[max(0.5rem,env(safe-area-inset-top))]">
        <p className="min-w-0 flex-1 truncate text-sm text-white/80">
          {title}
          {video.channel && <span className="text-white/70"> · {video.channel}</span>}
        </p>
        <a href={youtubeWatchUrl(video.videoId)} target="_blank" rel="noopener noreferrer" className="btn btn-circle btn-sm btn-text text-white hover:bg-white/15" aria-label={t`Open ${ph({ title })} on YouTube`} title={t`Open on YouTube`}>
          <span className="icon-[tabler--brand-youtube] size-5" />
        </a>
        <button ref={closeButton} type="button" className="btn btn-sm btn-soft ms-1 border-0 bg-white/15 text-white hover:bg-white/25" onClick={onClose}>
          <Trans>Close</Trans>
        </button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <div className="aspect-video max-h-full w-full max-w-5xl">
          {/* YouTube's player won't play without knowing which site it's on: this frame alone sends Ferret's address (not the page). */}
          <iframe
            src={youtubeEmbedUrl(video.videoId)}
            title={title}
            className="size-full"
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            referrerPolicy="strict-origin-when-cross-origin"
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** The task dialog's How-to videos: play, add (search or paste), remove. */
export function TaskVideos({ task, householdId, canEdit }: { task: MaintenanceTask; householdId: string; canEdit: boolean }) {
  const qc = useQueryClient();
  const [videos, setVideos] = useState<TaskVideo[]>(task.videos);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [playing, setPlaying] = useState<Playable | null>(null);
  const changed = () => void qc.invalidateQueries({ queryKey: ["maintenance", householdId] });
  const add = useMutation({
    mutationFn: (url: string) => api.addTaskVideo(task.id, url),
    onSuccess: (v) => {
      setVideos((list) => (list.some((x) => x.id === v.id) ? list : [...list, v]));
      changed();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.removeTaskVideo(task.id, id),
    onSuccess: (_, id) => {
      setVideos((list) => list.filter((x) => x.id !== id));
      setRemoving(null);
      changed();
    },
  });
  if (!canEdit && !videos.length) return null;

  return (
    <div className="space-y-2">
      <h4 className="flex items-center gap-2 text-sm font-medium text-base-content/70">
        <span className="icon-[tabler--brand-youtube] size-4" />
        <Trans>How-to videos</Trans>
      </h4>
      {videos.length > 0 && (
        <ul className="space-y-2">
          {videos.map((v) => (
            <li key={v.id} className="flex items-center gap-3">
              <button type="button" className="flex min-w-0 flex-1 items-center gap-3 text-start" onClick={() => setPlaying(v)}>
                <Thumb videoId={v.videoId} className="h-12 w-20" />
                <span className="min-w-0">
                  <span className="line-clamp-2 text-sm text-base-content">{v.title ?? t`YouTube video`}</span>
                  <span className="block truncate text-xs text-base-content/70">{[v.channel, v.seconds != null ? videoLength(v.seconds) : null].filter(Boolean).join(" · ")}</span>
                </span>
              </button>
              {canEdit &&
                (removing === v.id ? (
                  <span className="flex shrink-0 items-center gap-1">
                    <button type="button" className="btn btn-error btn-sm" disabled={remove.isPending} onClick={() => remove.mutate(v.id)}>
                      <Trans>Remove</Trans>
                    </button>
                    <button type="button" className="btn btn-text btn-sm" onClick={() => setRemoving(null)}>
                      <Trans>Keep</Trans>
                    </button>
                  </span>
                ) : (
                  <button type="button" className="btn btn-circle btn-text btn-sm shrink-0" aria-label={t`Remove ${ph({ title: v.title ?? t`this video` })}`} onClick={() => setRemoving(v.id)}>
                    <span className="icon-[tabler--x] size-4" />
                  </button>
                ))}
            </li>
          ))}
        </ul>
      )}
      {remove.isError && <p className="text-sm text-error">{remove.error.message}</p>}
      {canEdit &&
        (adding ? (
          <AddVideo
            task={task}
            pending={add.isPending}
            error={add.isError ? add.error.message : null}
            added={videos.map((v) => v.videoId)}
            onAdd={(url) => add.mutate(url)}
            onDone={() => setAdding(false)}
          />
        ) : (
          <button type="button" className="btn btn-soft btn-sm" onClick={() => setAdding(true)}>
            <span className="icon-[tabler--plus] size-4" />
            <Trans>Add a video</Trans>
          </button>
        ))}
      {playing && <VideoPlayer video={playing} onClose={() => setPlaying(null)} />}
    </div>
  );
}

function AddVideo(props: { task: MaintenanceTask; pending: boolean; error: string | null; added: string[]; onAdd: (url: string) => void; onDone: () => void }) {
  const { task } = props;
  const features = useFeatures();
  const canSearch = features?.videoSearch === true;
  const suggested = [task.itemName, task.title].filter(Boolean).join(" ");
  const [words, setWords] = useState(suggested);
  const [asked, setAsked] = useState<string | null>(null);
  const [link, setLink] = useState("");
  const [preview, setPreview] = useState<Playable | null>(null);
  const found = useQuery({ queryKey: ["video-search", asked], queryFn: () => api.searchVideos(asked!), enabled: canSearch && Boolean(asked), staleTime: 60 * 60_000 });
  const linkOk = youtubeId(link) !== null;

  // Enter in these boxes must not save the task's form around them.
  const onEnter = (go: () => void) => (e: React.KeyboardEvent) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    go();
  };
  const search = () => words.trim() && setAsked(words.trim());
  const paste = () => {
    if (!linkOk) return;
    props.onAdd(link.trim());
    setLink("");
  };

  return (
    <div className="space-y-3 rounded-box border border-base-content/10 p-3">
      {canSearch ? (
        <div className="space-y-2">
          <label className="label-text" htmlFor="video-search">
            <Trans>Search YouTube</Trans>
          </label>
          <div className="join w-full">
            <input id="video-search" type="search" className="input join-item min-w-0 flex-1" value={words} onChange={(e) => setWords(e.target.value)} onKeyDown={onEnter(search)} maxLength={200} />
            <button type="button" className="btn btn-primary join-item" onClick={search} disabled={!words.trim() || found.isFetching}>
              {found.isFetching ? <span className="loading loading-spinner loading-sm" /> : <span className="icon-[tabler--search] size-4" />}
              <span className="max-sm:sr-only"><Trans>Search</Trans></span>
            </button>
          </div>
          {found.isError && <p className="text-sm text-error">{found.error.message}</p>}
          {found.data && found.data.results.length === 0 && <p className="text-sm text-base-content/70"><Trans>No videos found. Try other words.</Trans></p>}
          {found.data && found.data.results.length > 0 && (
            <ul className="max-h-96 space-y-2 overflow-y-auto">
              {found.data.results.map((hit: VideoHit) => {
                const isAdded = props.added.includes(hit.videoId);
                return (
                  <li key={hit.videoId} className="flex items-center gap-3">
                    <button type="button" className="flex min-w-0 flex-1 items-center gap-3 text-start" onClick={() => setPreview(hit)} aria-label={t`Watch ${ph({ title: hit.title })}`}>
                      <Thumb videoId={hit.videoId} className="h-12 w-20" />
                      <span className="min-w-0">
                        <span className="line-clamp-2 text-sm text-base-content">{hit.title}</span>
                        <span className="block truncate text-xs text-base-content/70">{[hit.channel, hit.seconds != null ? videoLength(hit.seconds) : null].filter(Boolean).join(" · ")}</span>
                      </span>
                    </button>
                    {isAdded ? (
                      <span className="badge badge-soft badge-success shrink-0"><Trans>Added</Trans></span>
                    ) : (
                      <button type="button" className="btn btn-soft btn-primary btn-sm shrink-0" disabled={props.pending} onClick={() => props.onAdd(hit.videoId)}>
                        <Trans>Add</Trans>
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : (
        features && (
          <div className="space-y-1">
            <a href={youtubeSearchUrl(suggested || task.title)} target="_blank" rel="noopener noreferrer" className="btn btn-soft btn-sm">
              <span className="icon-[tabler--brand-youtube] size-4" />
              <Trans>Find one on YouTube</Trans>
            </a>
            <p className="text-xs text-base-content/70"><Trans>Then copy the video's link (Share → Copy link) and paste it here.</Trans></p>
          </div>
        )
      )}

      <div className="space-y-1">
        <label className="label-text" htmlFor="video-link">
          {canSearch ? <Trans>Or paste a YouTube link</Trans> : <Trans>YouTube link</Trans>}
        </label>
        <div className="join w-full">
          <input
            id="video-link"
            type="url"
            inputMode="url"
            className="input join-item min-w-0 flex-1"
            // not translated
            placeholder="https://youtu.be/…"
            value={link}
            onChange={(e) => setLink(e.target.value)}
            onKeyDown={onEnter(paste)}
            aria-invalid={link.trim() !== "" && !linkOk}
          />
          <button type="button" className="btn btn-primary join-item" onClick={paste} disabled={!linkOk || props.pending}>
            {props.pending ? <span className="loading loading-spinner loading-sm" /> : <Trans>Add</Trans>}
          </button>
        </div>
        {link.trim() !== "" && !linkOk && <p className="text-xs text-error"><Trans>That isn't a YouTube link.</Trans></p>}
      </div>
      {props.error && <p className="text-sm text-error">{props.error}</p>}
      <button type="button" className="btn btn-text btn-sm" onClick={props.onDone}>
        <Trans>Done adding</Trans>
      </button>
      {preview && <VideoPlayer video={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}

/**
 * Ferret's mascot, for screens with nothing on them yet: a pose cut out of its background (ferret-videos'
 * brand/mascot/cutouts, defringed so his fur doesn't glow on dark), standing at the bottom of a square with a soft
 * shadow under him. Decorative: the words beside it say what's going on. The full-size drawings are in the
 * ferret-videos repo (brand/mascot).
 */
import asleep from "./assets/mascot/asleep.webp";
import box from "./assets/mascot/box.webp";
import puzzled from "./assets/mascot/puzzled.webp";
import searching from "./assets/mascot/searching.webp";

const POSES = {
  /** Carrying a box: nothing added yet. */
  box,
  /** Asleep on a box: nothing to do. */
  asleep,
  /** Scratching his head over an empty box: not found. */
  puzzled,
  /** Peering through a magnifying glass: nothing matches. */
  searching,
};

export function Mascot({ pose, className = "size-32" }: { pose: keyof typeof POSES; className?: string }) {
  return (
    <img src={POSES[pose]} alt="" width={480} height={480} decoding="async" className={`shrink-0 drop-shadow-[0_6px_6px_rgb(0_0_0/0.25)] ${className}`} />
  );
}

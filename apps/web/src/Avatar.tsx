import type { Avatar as AvatarType } from '../../../packages/shared/types';
export const emptyAvatar: AvatarType = { shape: 'blob', color: '#a0bc92', accent: '#303e34' };
export function Avatar({
  avatar,
  size = 64,
  busy = false,
}: {
  avatar: AvatarType;
  size?: number;
  busy?: boolean;
}) {
  const paths = {
    wedge: 'M16 76 43 20Q48 10 55 21L91 75Q98 88 82 89H29Q10 89 16 76Z',
    blob: 'M20 77C3 63 15 30 35 23 52 1 83 21 84 39 105 63 85 88 66 88 47 101 35 85 20 77Z',
    teardrop: 'M53 12C49 30 16 42 16 65a35 29 0 0 0 70 0C86 42 60 29 53 12Z',
    robot: 'M23 33Q12 33 12 46V74Q12 88 27 88H76Q90 88 90 74V46Q90 33 77 33Z',
    cat: 'M20 46 17 15Q19 10 39 29Q53 23 66 29L86 14Q92 10 87 48C104 94 4 107 20 46Z',
    ghost: 'M17 83V47a35 35 0 0 1 70 0v36q-1 9-10 1l-8-6-11 10q-5 4-10-1l-10-9-11 7q-10 7-10-2Z',
    flower:
      'M39 22C39 3 66 3 66 22C83 10 101 33 85 45C107 50 99 79 81 74C86 96 58 104 52 86C40 104 16 89 24 73C2 77 1 49 22 44C6 28 26 10 39 22Z',
    heart: 'M52 30C24-1 1 29 17 54L45 87Q52 96 59 87L87 54C103 29 80-1 52 30Z',
    cloud: 'M26 87C1 87 1 49 23 46C17 20 49 8 63 30C84 18 99 37 90 54C111 69 95 88 80 87Z',
    hex: 'M29 15Q25 15 22 20L7 48Q4 53 7 59L23 85Q26 90 32 90H73Q79 90 82 85L98 58Q101 53 98 48L82 20Q79 15 74 15Z',
    star: 'M47 15Q52 5 57 15L68 35 91 39Q102 41 94 50L78 66 81 89Q82 100 72 95L52 84 32 95Q22 100 23 89L26 66 10 50Q2 41 13 39L36 35Z',
    house: 'M12 47 43 16Q52 7 61 16L92 47Q99 55 89 58V80Q89 91 78 91H26Q15 91 15 80V58Q4 55 12 47Z',
  };
  return (
    <svg
      className={`avatar ${busy ? 'is-busy' : ''}`}
      width={size}
      height={size}
      viewBox="0 0 104 104"
      aria-hidden="true"
    >
      <ellipse
        className="avatar-shadow"
        cx="52"
        cy="94"
        rx="27"
        ry="4"
        fill={avatar.accent}
        opacity=".09"
      />
      <g className="avatar-body">
        {avatar.shape === 'robot' && (
          <>
            <path d="M52 32V20" stroke={avatar.accent} strokeWidth="3" />
            <circle cx="52" cy="17" r="5" fill={avatar.color} />
            <rect x="5" y="50" width="8" height="21" rx="4" fill={avatar.color} />
            <rect x="89" y="50" width="8" height="21" rx="4" fill={avatar.color} />
          </>
        )}
        <path d={paths[avatar.shape] ?? paths.blob} fill={avatar.color} />
        <path
          d={paths[avatar.shape] ?? paths.blob}
          fill="white"
          opacity=".07"
          transform="translate(-3 -5) scale(.97)"
        />
        <g className="avatar-eyes" fill={avatar.accent}>
          <ellipse cx="41" cy="56" rx="3.4" ry="5.3" />
          <ellipse cx="65" cy="56" rx="3.4" ry="5.3" />
        </g>
        <ellipse cx="31" cy="65" rx="5.6" ry="3" fill="#fff" opacity=".28" />
        <ellipse cx="75" cy="65" rx="5.6" ry="3" fill="#fff" opacity=".28" />
        <path
          d="M47 69q6 6 12-1"
          fill="none"
          stroke={avatar.accent}
          strokeWidth="2.4"
          strokeLinecap="round"
        />
      </g>
    </svg>
  );
}

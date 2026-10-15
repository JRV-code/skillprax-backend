/**
 * Comprehensive In-Memory Instant Athletic Taxonomy (< 20ms resolution)
 * Maps major sports and physical disciplines to 5-7 authentic positional and technical sub-genres.
 */

export interface SportSpecialization {
  keywords: string[];
  subgenres: string[];
}

export const SPORTS_TAXONOMY: Record<string, SportSpecialization> = {
  football: {
    keywords: ['football', 'soccer', 'futbol', 'fifa'],
    subgenres: [
      'Striker & Clinical Finishing Mechanics',
      'Central Midfield Playmaking & Spatial Vision',
      'Defensive Pressing, Interceptions & Tackling',
      'Goalkeeping Positioning, Diving & Distribution',
      'Tactical Transition, Wing Play & Crossing',
      'Set-Piece Delivery, Bending & Aerial Heading',
    ],
  },
  cricket: {
    keywords: ['cricket'],
    subgenres: [
      'Pace Bowling Dynamics & Seam Presentation',
      'Spin Bowling Revolutions & Drift Variations',
      'Top-Order Defensive & Forward Drive Mechanics',
      'Power Hitting, Lofted Drives & Death Overs',
      'Wicketkeeping Footwork, Gathering & Stumping',
      'Boundary Outfielding & Direct Hit Throwing',
    ],
  },
  basketball: {
    keywords: ['basketball', 'hoops', 'nba'],
    subgenres: [
      'Shooting Form, Arc & Catch-and-Shoot Mechanics',
      'Pick-and-Roll Decision Making & Pocket Passes',
      'Perimeter On-Ball Defense & Lateral Sliding',
      'Post-Up Footwork, Drop Steps & Rim Protection',
      'Point Guard Dribble Drive & Court Vision',
      'Rebounding Box-Out & Fast Break Transition',
    ],
  },
  badminton: {
    keywords: ['badminton'],
    subgenres: [
      'Deceptive Drop Shots, Tumbling Nets & Slices',
      'Full Jump Smash Kinetic Power Transfer',
      'Forecourt Lunge Footwork & Split-Step Recovery',
      'Rearcourt Defensive Lifting & High Clears',
      'Fast Flat Drives & Doubles Interceptions',
      'Short Serve Precision & Return of Serve Attacks',
    ],
  },
  tennis: {
    keywords: ['tennis'],
    subgenres: [
      'Topspin Forehand Kinetic Chain & Racket Lag',
      'Two-Handed & One-Handed Backhand Drive Depth',
      'Flat & Kick Serve Toss, Pronation & Placement',
      'Volleys, Overhead Smashes & Net Transition',
      'Baseline Defensive Scrambling & Open-Stance Recovery',
      'Touch Slices, Drop Shots & Lob Trajectories',
    ],
  },
  tabletennis: {
    keywords: ['table tennis', 'ping pong', 'tabletennis'],
    subgenres: [
      'Forehand Topspin Loop & Third-Ball Attacks',
      'Backhand Banana Flick & Close-Table Counters',
      'Short Push, Heavy Undercut & Defensive Chopping',
      'Deceptive Pendulum & Reverse Tomahawk Serves',
      'Lateral Crossover Footwork & Transition Speed',
      'Block Placement & Mid-Distance Counter-Looping',
    ],
  },
  swimming: {
    keywords: ['swimming', 'swim', 'swimmer'],
    subgenres: [
      'Freestyle High-Elbow Catch, Body Roll & Kick',
      'Breaststroke Whip Kick, Glide Timing & Pull',
      'Butterfly Undulation, Rhythm & Power Recovery',
      'Backstroke Shoulder Rotation & Deep Hand Entry',
      'Flip Turn Tumble, Push-Off & Underwater Streamline',
      'Aerobic Pacing, VO2 Max Intervals & Breathing Flow',
    ],
  },
  running: {
    keywords: ['running', 'sprinting', 'athletics', 'track and field', 'sprint', 'marathon', 'jogging'],
    subgenres: [
      'Sprint Drive Phase, Low Heel Recovery & Blocks',
      'Max Velocity Upright Mechanics & Hip Projection',
      'Distance Aerobic Threshold & Cadence Pacing',
      'Plyometric Tendon Stiffness & Ground Reaction Force',
      'Curve Running, Deceleration & Stride Frequency',
      'Breathing Rhythms, Arm Carriage & Core Rigidity',
    ],
  },
  calisthenics: {
    keywords: ['calisthenics', 'street workout', 'bodyweight'],
    subgenres: [
      'Strict Bar & Ring Muscle-Up Transitions',
      'Front Lever Retraction & Horizontal Core Holds',
      'Planche Protraction, Shoulder Lean & Straight Arms',
      'Freestanding Handstand Balance & Press Variations',
      'Explosive Pull-Up Power & L-Sit Core Stability',
      'Weighted Dips & Pull-Ups Progressive Overload',
    ],
  },
  gymnastics: {
    keywords: ['gymnastics', 'gymnast', 'artistic gymnastics'],
    subgenres: [
      'Floor Exercise Round-Off, Back Handspring & Twisting',
      'Pommel Horse Circles, Scissor Swings & Spindle Travel',
      'Still Rings Iron Cross, Inverted Hang & Dislocates',
      'Vault Yurchenko Run-Up, Table Block & Post-Flight',
      'Parallel Bars Kip, Diamidov Turn & Dismount Form',
      'Active Flexibility, Pointed Toe Lines & Joint Stability',
    ],
  },
  boxing: {
    keywords: ['boxing', 'boxer', 'pugilism'],
    subgenres: [
      'Lead Jab Velocity, Snapping Mechanics & Distance Control',
      'Rear Cross & Lead Hook Kinetic Weight Transfer',
      'Slip, Roll, Bob-and-Weave Defensive Evasion',
      'Pivot Footwork, Ring Generalship & Angle Cutting',
      'Inside Infighting, Liver Punching & Short Hooks',
      'Counter-Punch Timing, Feinting & Trap Setting',
    ],
  },
  mma: {
    keywords: ['mma', 'mixed martial arts', 'martial arts', 'combat', 'ufc'],
    subgenres: [
      'Level Changes, Double-Leg & High Crotch Takedowns',
      'Cage Wall Wrestling, Head Position & Pummeling',
      'BJJ Guard Passing, Mount Retention & Back Control',
      'Submission Mechanics (Rear-Naked Choke, Armbars, Guillotines)',
      'Striking-to-Grappling Blends & Overhand Counter Attacks',
      'Ground-and-Pound Posture, Guard Defense & Hip Escapes',
    ],
  },
  weightlifting: {
    keywords: ['weightlifting', 'powerlifting', 'strength training', 'gym', 'bodybuilding', 'lifting'],
    subgenres: [
      'Snatch First Pull, Triple Extension & Overhead Squat Catch',
      'Clean & Jerk Hip Thrust, Dip-Drive & Split Jerk Balance',
      'Low-Bar / High-Bar Squat Torso Rigidity & Knee Tracking',
      'Conventional & Sumo Deadlift Wedge Setup & Lockout',
      'Barbell Bench Press Leg Drive, Arch & Bar Path Control',
      'Overhead Strict Press Core Bracing & Scapular Elevation',
    ],
  },
  yoga: {
    keywords: ['yoga', 'pranayama', 'asana', 'yogasan', 'yogic'],
    subgenres: [
      'Ashtanga Vinyasa Sun Salutations & Breath-Movement Flow',
      'Standing Balance & Hip Openers (Virabhadrasana, Vrikshasana)',
      'Spinal Mobility, Decompression & Backbends (Chakrasana)',
      'Arm Balances & Inversions (Bakasana, Sirshasana Stability)',
      'Pranayama Diaphragmatic Breath Control (Kapalabhati, Anulom Vilom)',
      'Yin Restorative Fascial Release & Deep Muscular Recovery',
    ],
  },
  cycling: {
    keywords: ['cycling', 'bicycle', 'bike', 'road cycling', 'mtb', 'mountain biking'],
    subgenres: [
      'Smooth Pedal Stroke Efficiency & Cadence Optimization',
      'Aerodynamic Time-Trial Tuck & Drafting Dynamics',
      'Out-of-the-Saddle Climbing Torque & Gradient Pacing',
      'Cornering Lines, High-Speed Braking & Countersteering',
      'Zone 2 Base Aerobic Conditioning & Lactate Clearance',
      'Sprinting Explosive Watts & Gear Shifting Timing',
    ],
  },
  volleyball: {
    keywords: ['volleyball', 'beach volleyball'],
    subgenres: [
      'Three-Step Spike Approach, Arm Draw & Wrist Snap',
      'Jump Float & Jump Topspin Serve Trajectories',
      'Setting Soft Hands, Foot Alignment & Back Sets',
      'Forearm Passing Platform, Shrug & Angle Reflection',
      'Front-Row Block Timing, Hand Penetration & Sealing',
      'Sprawl, Pancake & Roll Defensive Floor Coverage',
    ],
  },
  hockey: {
    keywords: ['hockey', 'field hockey', 'ice hockey'],
    subgenres: [
      'Push Passing, Slap Hits & Smooth Receiving Control',
      'Drag Flick Kinetic Acceleration & Penalty Corners',
      'Reverse Stick Tomahawk & Raised Backhand Striking',
      '3D Jinking, Aerial Lifts & Close-Quarters Dribbling',
      'Channeling Footwork & Defensive Stick-Tackle Timing',
      'Defensive Shuffling & Offensive Circle Infiltration',
    ],
  },
  skating: {
    keywords: ['skating', 'skateboard', 'skateboarding', 'inline skating', 'roller skating'],
    subgenres: [
      'Ollie Tail Pop, Foot Slide & Leveling Dynamics',
      'Edge Carving, Crossover Pushing & Speed Control',
      'Transition Pumping, Drop-Ins & Vert Wall Riding',
      'Flip Trick Foot Placement & Catch Timing (Kickflip/Heelflip)',
      'Grind Balance, Ledge Locks & Slide Transitions',
      'Safe Falling Mechanics, Rolls & Impact Dissipation',
    ],
  },
  archery: {
    keywords: ['archery', 'bow and arrow', 'recurve', 'compound bow'],
    subgenres: [
      'Stance Foundation, Core Posture & Shoulder T-Alignment',
      'Anchor Point Consistency, Hook Grip & Finger Pressure',
      'Back Tension, Rhomboid Expansion & Surprise Release',
      'Sight Picture Stabilization & Mental Focusing Routine',
      'Bow Arm Extension & Torqueless Grip Placement',
      'Follow-Through Rhythm & Wind Adjustment Diagnostics',
    ],
  },
};

/**
 * Instant Tier 1 Lookup for Sports Subgenres (< 15ms)
 */
export function getInstantSportsSubgenres(skillName: string): string[] | null {
  if (!skillName || typeof skillName !== 'string') return null;
  const clean = skillName.trim().toLowerCase();

  for (const entry of Object.values(SPORTS_TAXONOMY)) {
    for (const kw of entry.keywords) {
      if (clean === kw || clean.startsWith(kw + ' ') || clean.endsWith(' ' + kw) || clean.includes(kw)) {
        return entry.subgenres;
      }
    }
  }

  return null;
}

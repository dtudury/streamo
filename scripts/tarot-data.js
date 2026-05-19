/**
 * Tarot demo dataset.
 *
 * Used by the chat dev server to seed a non-Repo Streamo — `repo.set(data)`
 * with no `.commit()` — so the byte stream contains data chunks but no
 * commit/signature chunks. The explorer's no-head case is what surfaces
 * this. Theme is just for flavor; the shape is what matters: nested
 * objects, arrays of objects, mixed primitive types.
 */

const MAJOR_ARCANA = [
  { number: 0, name: 'The Fool', element: 'air', planet: 'Uranus',
    keywords: ['beginnings', 'innocence', 'spontaneity', 'free spirit', 'leap of faith'],
    uprightMeaning: 'New beginnings, openness, trust in life. Stepping into the unknown with curiosity rather than dread. The Fool is the protagonist of the deck — every card after is something they meet on the road.',
    reversedMeaning: 'Recklessness, naivete that costs you, refusing to learn from missteps. The leap is taken without looking, and the cliff this time is real.',
    imagery: 'A young figure in patterned clothing steps toward a cliff edge, a small white dog at their heels, a white rose in one hand and a satchel on a stick over the shoulder. The sun is bright and high.' },
  { number: 1, name: 'The Magician', element: 'air', planet: 'Mercury',
    keywords: ['manifestation', 'willpower', 'skill', 'concentration', 'self-confidence'],
    uprightMeaning: 'You have what you need to make it real. The four suits are on your table — wand, cup, sword, pentacle — and the channel between heaven and earth is open through you.',
    reversedMeaning: 'Manipulation, untapped potential, smoke and mirrors. The skill is there but turned toward illusion or self-deception.',
    imagery: 'A robed figure stands behind a table holding a wand high; an infinity symbol hovers above their head. The four suit symbols lie on the table.' },
  { number: 2, name: 'The High Priestess', element: 'water', planet: 'Moon',
    keywords: ['intuition', 'mystery', 'inner voice', 'subconscious', 'sacred knowledge'],
    uprightMeaning: 'Listen to what you already know but havent put into words. The High Priestess is the threshold between conscious and subconscious — she holds the scroll you cant fully read yet.',
    reversedMeaning: 'Disconnection from intuition, secrets weaponized, the inner voice silenced or drowned out by external pressure.',
    imagery: 'A seated woman in blue robes between two pillars — one black (Boaz), one white (Jachin) — with a crescent moon at her feet and a scroll partly visible in her lap.' },
  { number: 3, name: 'The Empress', element: 'earth', planet: 'Venus',
    keywords: ['fertility', 'nurturing', 'abundance', 'sensuality', 'creative force'],
    uprightMeaning: 'Generative abundance — the wheat is ripening, the garden is full, projects are blooming. Take pleasure in what you have grown.',
    reversedMeaning: 'Smothering, over-attachment, creativity blocked. Too much yielding becomes diffuse; the harvest rots if never picked.',
    imagery: 'A crowned woman with twelve stars in her crown reclines on cushions in a wheat field; a stream flows nearby and a shield with the symbol of Venus rests beside her.' },
  { number: 4, name: 'The Emperor', element: 'fire', planet: 'Mars',
    keywords: ['authority', 'structure', 'control', 'fatherhood', 'stability'],
    uprightMeaning: 'Build the framework. Set the rules. The Emperor is the impulse to order — to take the raw fire of will and channel it into institutions, plans, defended boundaries.',
    reversedMeaning: 'Rigidity, tyranny, control wielded as cruelty. The frame becomes a cage; rules outlive their purpose.',
    imagery: 'A bearded king in armor sits on a throne of carved ram heads, holding an ankh-topped scepter and a globe. Mountains stretch behind him under a red-orange sky.' },
  { number: 5, name: 'The Hierophant', element: 'earth', planet: 'Taurus',
    keywords: ['tradition', 'institutions', 'belief systems', 'conformity', 'spiritual guidance'],
    uprightMeaning: 'The wisdom of the lineage — what has been preserved because it was tested. Find your teacher, study the tradition, accept the structure that already exists.',
    reversedMeaning: 'Dogma calcified, the institution serving itself rather than its charge. Time to leave the church and find your own way.',
    imagery: 'A priest in three-tiered crown sits between two pillars, raising a hand in benediction over two kneeling acolytes; crossed keys lie at his feet.' },
  { number: 6, name: 'The Lovers', element: 'air', planet: 'Gemini',
    keywords: ['union', 'choices', 'values alignment', 'partnership', 'duality'],
    uprightMeaning: 'A choice that matters made from the heart, not the head. The Lovers names a values-alignment decision — what you join with becomes what you become.',
    reversedMeaning: 'Misalignment, choices made from fear, the relationship that compromises rather than completes.',
    imagery: 'A nude man and woman stand before an angel in clouds; the tree of life behind the woman holds a serpent, the tree of flame behind the man is bare.' },
  { number: 7, name: 'The Chariot', element: 'water', planet: 'Cancer',
    keywords: ['willpower', 'victory', 'direction', 'self-discipline', 'forward motion'],
    uprightMeaning: 'You can steer this. Two forces pulling in different directions — body and mind, hope and fear, light and shadow — and you hold the reins of both.',
    reversedMeaning: 'Loss of control, scattered direction, the two sphinxes pulling in different ways without a charioteer to harmonize them.',
    imagery: 'An armored figure stands in a stone chariot drawn by two sphinxes (one black, one white). A starry canopy stretches overhead; the city walls behind have been crossed.' },
  { number: 8, name: 'Strength', element: 'fire', planet: 'Leo',
    keywords: ['inner strength', 'compassion', 'patience', 'gentleness', 'courage'],
    uprightMeaning: 'Soft hands close the lions mouth. The strength here is not domination but the patience to befriend what most threatens you. Compassion as a discipline.',
    reversedMeaning: 'Self-doubt, fear running the show, the lion turned predator because no one has been kind to it.',
    imagery: 'A woman in white robes calmly closes a lions mouth with her hands. A garland of roses crowns both her head and the lions neck; an infinity symbol floats above her.' },
  { number: 9, name: 'The Hermit', element: 'earth', planet: 'Virgo',
    keywords: ['solitude', 'introspection', 'inner guidance', 'withdrawal', 'soul-searching'],
    uprightMeaning: 'Withdraw to find the answer. The lamp the Hermit holds is small — it lights one step at a time. You are seeking truth, not certainty.',
    reversedMeaning: 'Isolation become loneliness, withdrawal as avoidance, the inner light dimmed because you stopped trusting it.',
    imagery: 'A cloaked elder stands on a mountain peak, holding aloft a six-pointed-star lantern. A long staff supports his other hand.' },
  { number: 10, name: 'Wheel of Fortune', element: 'fire', planet: 'Jupiter',
    keywords: ['cycles', 'fate', 'change', 'turning points', 'destiny'],
    uprightMeaning: 'The wheel turns. What was up comes down; what was buried surfaces. Things are about to shift — your job is to ride the change with grace, not to grasp at the spoke that is going under.',
    reversedMeaning: 'Bad luck cycles, feeling stuck on the descending side of the wheel, resisting changes that are already in motion.',
    imagery: 'A great wheel labeled with letters (T-A-R-O / R-O-T-A) suspended in clouds, with a sphinx atop, a serpent descending one side and an anubis rising the other. The four fixed-sign creatures occupy the corners.' },
  { number: 11, name: 'Justice', element: 'air', planet: 'Libra',
    keywords: ['fairness', 'cause and effect', 'truth', 'accountability', 'balance'],
    uprightMeaning: 'The reckoning. What was put into motion is being weighed. Justice in this deck is not punishment — it is the moment where consequences arrive and you see clearly what you have made.',
    reversedMeaning: 'Unfairness, evasion of accountability, scales tipped by power or self-deception.',
    imagery: 'A crowned figure in red robes sits between two stone pillars, holding upright sword in one hand and balanced scales in the other.' },
  { number: 12, name: 'The Hanged Man', element: 'water', planet: 'Neptune',
    keywords: ['surrender', 'new perspective', 'pause', 'sacrifice', 'letting go'],
    uprightMeaning: 'Stop forcing it. The Hanged Mans inverted view is not punishment — it is voluntary suspension, the choice to see things from a different angle by giving up the angle you had.',
    reversedMeaning: 'Stalling, martyrdom, sacrifice without growth — hanging there because you are stuck, not because you are learning.',
    imagery: 'A young man hangs by one ankle from a T-shaped living tree, his other leg crossed behind. A halo glows around his serene head; his hands are bound behind his back.' },
  { number: 13, name: 'Death', element: 'water', planet: 'Scorpio',
    keywords: ['endings', 'transformation', 'transition', 'release', 'rebirth'],
    uprightMeaning: 'Something is ending — and that is not the same as something going wrong. Death in this deck is the door, not the cellar. What was finished is being composted into what comes next.',
    reversedMeaning: 'Refusal to let go, holding onto the corpse of a relationship or identity past its life. The transformation is being denied.',
    imagery: 'A skeletal knight in black armor on a white horse rides past a fallen king, a kneeling bishop, a child, and a maiden. A sun rises between two distant towers.' },
  { number: 14, name: 'Temperance', element: 'fire', planet: 'Sagittarius',
    keywords: ['balance', 'moderation', 'patience', 'integration', 'alchemy'],
    uprightMeaning: 'Blend, dont choose. Temperance is the practice of mixing opposites until they become a third thing. The angel pours water back and forth between cups and never spills — that is the discipline.',
    reversedMeaning: 'Imbalance, impatience, the alchemy abandoned because the integration takes longer than you wanted.',
    imagery: 'An angel with one foot in a stream and one on dry land pours water between two golden cups. An iris blooms beside the path; a sunlit crown shines on the horizon.' },
  { number: 15, name: 'The Devil', element: 'earth', planet: 'Capricorn',
    keywords: ['bondage', 'addiction', 'materialism', 'shadow self', 'unconscious patterns'],
    uprightMeaning: 'The chains you wear are loose — you could lift them off. The Devil names the pattern you call inevitable that is actually a choice you keep remaking. Look at what you cling to.',
    reversedMeaning: 'Breaking free, recognizing the chain is loose, the shadow-pattern losing its grip as you name it.',
    imagery: 'A horned, winged figure sits on a black pedestal; a chained man and woman stand on either side, the chains looped lightly enough to slip off. An inverted torch in the Devils hand.' },
  { number: 16, name: 'The Tower', element: 'fire', planet: 'Mars',
    keywords: ['sudden change', 'upheaval', 'revelation', 'breaking down', 'awakening'],
    uprightMeaning: 'The structure was built on a faulty foundation — the lightning reveals it all at once. The tower falling is brutal but clarifying; what was false has been named false.',
    reversedMeaning: 'Avoided revelation, the warning ignored, a slower-motion version of the same fall coming later with interest.',
    imagery: 'A stone tower struck by lightning, its crown blown off, two figures falling from the top into a dark void. Flames pour from the windows.' },
  { number: 17, name: 'The Star', element: 'air', planet: 'Aquarius',
    keywords: ['hope', 'renewal', 'serenity', 'inspiration', 'spirituality'],
    uprightMeaning: 'After the Tower, the Star. The night is dark but the sky has cleared. The Star says: keep going. Pour the water gently; the well refills.',
    reversedMeaning: 'Despair, faith lost, the night sky covered over by clouds. Hope feels foolish — but the absence of hope is also a position you have to defend.',
    imagery: 'A nude woman kneels by a pool, one foot in the water and one on land, pouring water from two jugs — one onto the ground, one into the pool. Seven small stars surround one large eight-pointed star above.' },
  { number: 18, name: 'The Moon', element: 'water', planet: 'Pisces',
    keywords: ['illusion', 'fear', 'subconscious', 'intuition', 'dreams'],
    uprightMeaning: 'You cant see clearly yet. The Moon governs the territory where the rational mind doesnt work — dreams, intuitions, fears with no obvious cause. Trust the body but verify what it tells you slowly.',
    reversedMeaning: 'Confusion lifting, illusion seen through, the long path under moonlight finally reaching its end.',
    imagery: 'A full moon with a face in it casts pale light on a path between two towers; a wolf and a dog howl up at it from either side, and a crayfish emerges from the water in the foreground.' },
  { number: 19, name: 'The Sun', element: 'fire', planet: 'Sun',
    keywords: ['joy', 'vitality', 'success', 'positivity', 'enlightenment'],
    uprightMeaning: 'Things are working. The Sun is the card of arrival — the work is done, the celebration is honest, the child on the horse is the inner self at play. Receive the warmth without earning it harder.',
    reversedMeaning: 'Joy delayed, optimism shadowed, the sun behind a cloud. Not gone, just temporarily occluded.',
    imagery: 'A nude child on a white horse rides under a great smiling sun, holding a red banner. A wall of sunflowers blooms behind.' },
  { number: 20, name: 'Judgement', element: 'fire', planet: 'Pluto',
    keywords: ['rebirth', 'awakening', 'inner calling', 'reckoning', 'absolution'],
    uprightMeaning: 'You hear the call. The figures rise from their coffins not in horror but in gladness — the reckoning here is also the redemption. What is owed is being settled and what is buried is rising.',
    reversedMeaning: 'Ignoring the call, refusing the reckoning, the buried thing pushed back down instead of allowed to surface.',
    imagery: 'An angel with a trumpet blows above the clouds; below, naked figures rise from open coffins with arms outstretched. A red cross banner streams from the trumpet.' },
  { number: 21, name: 'The World', element: 'earth', planet: 'Saturn',
    keywords: ['completion', 'fulfillment', 'integration', 'wholeness', 'travel'],
    uprightMeaning: 'The cycle closes. The Fools journey arrives — every card has been met, integrated, danced with. Take the moment to feel the completion before stepping into the next ring.',
    reversedMeaning: 'A cycle that wont close, loose ends, the dance not yet finished. Something small but real still needs to be tended.',
    imagery: 'A dancing nude figure draped in a violet sash holds two wands inside a laurel wreath. The four fixed-sign creatures — angel, eagle, lion, bull — occupy the corners.' }
]

const SUITS = [
  { name: 'wands', element: 'fire', domain: 'creativity, passion, action, drive', season: 'spring',
    courtArchetype: 'the maker — generative, restless, sparks the new' },
  { name: 'cups', element: 'water', domain: 'emotion, intuition, relationships, soul', season: 'summer',
    courtArchetype: 'the listener — receptive, empathic, holds space' },
  { name: 'swords', element: 'air', domain: 'intellect, conflict, truth, communication', season: 'autumn',
    courtArchetype: 'the thinker — sharp, clarifying, sometimes wounding' },
  { name: 'pentacles', element: 'earth', domain: 'material, body, work, manifestation', season: 'winter',
    courtArchetype: 'the builder — grounded, patient, tends the slow harvest' }
]

const PIPS = [
  { rank: 'Ace', number: 1,
    upright: 'pure beginning — the suits essence in seed form, an opening',
    reversed: 'the seed refused, the opening missed or distrusted' },
  { rank: 'Two', number: 2,
    upright: 'choice, partnership, two forces in dialogue',
    reversed: 'imbalance between two forces, indecision, a partnership strained' },
  { rank: 'Three', number: 3,
    upright: 'expansion, first fruits, the third element that completes the pair',
    reversed: 'over-expansion, fruits forced too early, the third element disrupting rather than completing' },
  { rank: 'Four', number: 4,
    upright: 'stability, foundation, a pause to consolidate',
    reversed: 'stagnation, the foundation too rigid, comfort that has calcified' },
  { rank: 'Five', number: 5,
    upright: 'conflict, loss, the test that breaks the easy pattern',
    reversed: 'the conflict acknowledged, recovery beginning, the loss processed' },
  { rank: 'Six', number: 6,
    upright: 'harmony restored, generosity, balance after the fives challenge',
    reversed: 'generosity weaponized, harmony performative, balance kept by suppression' },
  { rank: 'Seven', number: 7,
    upright: 'reflection, choice between paths, assessment',
    reversed: 'avoidance of the reflection, false choices, paralysis at the crossroads' },
  { rank: 'Eight', number: 8,
    upright: 'mastery in progress, focused effort, the discipline of repetition',
    reversed: 'burnout, the discipline turned compulsive, effort without direction' },
  { rank: 'Nine', number: 9,
    upright: 'near-completion, the fruits of long labor, satisfaction',
    reversed: 'the near-completion held back, satisfaction soured, the last step refused' },
  { rank: 'Ten', number: 10,
    upright: 'culmination, the full cycle, fullness of the suit (for better or worse depending on suit)',
    reversed: 'culmination delayed, the cycle resisted, fullness as overwhelm' },
  { rank: 'Page', number: 11,
    upright: 'the suits energy as messenger — young, curious, new to its work',
    reversed: 'the messenger confused or untrustworthy, immaturity that costs' },
  { rank: 'Knight', number: 12,
    upright: 'the suits energy in motion — committed, sometimes reckless, the pursuit',
    reversed: 'the pursuit miscalibrated, the motion without direction, the knight charging into the wrong fight' },
  { rank: 'Queen', number: 13,
    upright: 'the suits energy embodied — mature, internal, presence',
    reversed: 'the embodiment turned inward to excess, the presence become brooding' },
  { rank: 'King', number: 14,
    upright: 'the suits energy mastered and externalized — authority, responsibility',
    reversed: 'authority become tyranny, mastery turned to fear of losing it' }
]

function minorCard (suit, pip) {
  return {
    name: `${pip.rank} of ${suit.name}`,
    suit: suit.name,
    rank: pip.rank,
    number: pip.number,
    element: suit.element,
    domain: suit.domain,
    upright: `${pip.upright} — in the realm of ${suit.domain}`,
    reversed: `${pip.reversed} — in the realm of ${suit.domain}`,
    isCourt: pip.number >= 11,
    courtArchetype: pip.number >= 11 ? suit.courtArchetype : null
  }
}

const MINOR_ARCANA = SUITS.flatMap(s => PIPS.map(p => minorCard(s, p)))

const SPREADS = [
  { name: 'Single card',
    positions: ['The Card'],
    description: 'A single draw for a question, mood, or theme. The most honest spread when you dont want the structure to do the work for you.' },
  { name: 'Three card',
    positions: ['Past', 'Present', 'Future'],
    description: 'The classic linear spread. Past = what brought you here, present = where you are, future = where the current trajectory points (not where you must end up).' },
  { name: 'Situation / Action / Outcome',
    positions: ['Situation', 'Action', 'Outcome'],
    description: 'A three-card variant focused on agency. Situation describes the field; action describes the response the cards suggest; outcome describes what that response opens.' },
  { name: 'Celtic Cross',
    positions: ['Present', 'Challenge', 'Distant past / foundation', 'Recent past', 'Above / conscious aim', 'Below / unconscious', 'Self', 'Environment', 'Hopes / fears', 'Outcome'],
    description: 'Ten-card spread. The cross of six in the middle (present, challenge, foundation, recent past, conscious aim, unconscious) describes the field; the staff of four on the right (self, environment, hopes/fears, outcome) describes how you stand in it.' }
]

const READINGS = [
  { date: '2026-05-12',
    spread: 'Three card',
    question: 'What does the week ahead want from me?',
    draws: [
      { position: 'Past', cardName: 'The Hermit', reversed: false,
        reflection: 'The recent solo work has been doing its job — withdraw was correct.' },
      { position: 'Present', cardName: 'Eight of Pentacles', reversed: false,
        reflection: 'You are in the discipline of the practice. Keep going, dont second-guess.' },
      { position: 'Future', cardName: 'The Sun', reversed: false,
        reflection: 'Something joyful is approaching. Let it land without earning it harder.' }
    ],
    note: 'Pulled before the de-naive arc landed. The Sun arriving felt almost too on-the-nose afterward.' },
  { date: '2026-05-16',
    spread: 'Single card',
    question: 'Whats the texture of today?',
    draws: [
      { position: 'The Card', cardName: 'Temperance', reversed: false,
        reflection: 'Blend, dont choose. A day for letting two opposing instincts find their proportion rather than committing to one.' }
    ],
    note: 'Drew this with my morning coffee. Held all day in the background.' },
  { date: '2026-05-19',
    spread: 'Situation / Action / Outcome',
    question: 'About the fine-grained watcher boundaries work',
    draws: [
      { position: 'Situation', cardName: 'Ten of Wands', reversed: true,
        reflection: 'The burden of the old single-watcher model recognized as unsustainable. Reversed = the load is being put down.' },
      { position: 'Action', cardName: 'The Magician', reversed: false,
        reflection: 'Skill at hand. The four suit-symbols on the table = recaller, instance, watcher, terraform. The work is in your range.' },
      { position: 'Outcome', cardName: 'The World', reversed: false,
        reflection: 'A cycle closes. The de-naive arc completes; the foundation is whole enough to step off of into whatever comes next.' }
    ],
    note: 'This one is documentation. Drew it after the 7.6.0 publish. Yes the cards lined up that obviously.' }
]

const NOTES = {
  about: 'A small structured tarot deck + sample readings. The data here is a non-Repo Streamo: the bytes were written via repo.set() without commit() or sign(), so the byte stream contains data chunks but no commit/signature records. The explorer\'s no-head case is what surfaces this — see at-view.js:104.',
  source: 'Card descriptions paraphrased from the Rider-Waite-Smith tradition (1909, public domain). No claim to esoteric authority — these are study notes, not prescriptions.',
  shape: 'Three top-level collections (majorArcana: array, minorArcana: array, spreads: array, readings: array) plus a few primitive fields. Designed to exercise the explorer\'s storage tree at depth and have something interesting to read.',
  cardCount: { major: MAJOR_ARCANA.length, minor: MINOR_ARCANA.length, total: MAJOR_ARCANA.length + MINOR_ARCANA.length }
}

export function buildTarotData () {
  return {
    deck: 'Rider-Waite-Smith (paraphrased)',
    notes: NOTES,
    majorArcana: MAJOR_ARCANA,
    minorArcana: MINOR_ARCANA,
    spreads: SPREADS,
    readings: READINGS
  }
}

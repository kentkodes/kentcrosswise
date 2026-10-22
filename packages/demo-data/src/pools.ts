// Word pools for the synthetic generator. Everything here is invented; combinations
// of common first and last names are random, not anyone in particular.
// Never add real people, real handles, emails or phone numbers.

export const FIRST_NAMES = [
  "Ada", "Bea", "Cal", "Dev", "Eli", "Fay", "Gus", "Hana", "Ivo", "Juno",
  "Kai", "Lior", "Mira", "Noor", "Oren", "Pia", "Quin", "Rhea", "Sol", "Tove",
  "Uma", "Vic", "Wren", "Xan", "Yara", "Zed",
] as const;

export const LAST_NAMES = [
  "Ashdown", "Brightwater", "Calloway", "Dunmore", "Everly", "Fairholm", "Greystone",
  "Hollowell", "Ironwood", "Juniper", "Kestrel", "Larkspur", "Merriweather", "Northcote",
  "Oakhurst", "Pennywhistle", "Quarrington", "Rosemoor", "Silverbirch", "Thornbury",
] as const;

export const HOW_KNOWN = [
  "college roommate", "old coworker", "climbing gym", "book club", "neighbor",
  "conference friend", "cousin", "running club", "former manager", "cooking class",
] as const;

export const TAGS = ["friend", "work", "family", "mentor", "climbing", "books", "music", "travel"] as const;

export const TOPICS = [
  "their new job", "a trip to the coast", "the book club pick", "a side project", "moving apartments",
  "a marathon plan", "learning the cello", "a startup idea", "the garden", "a photography class",
] as const;

export const PLANS = ["lunch", "coffee", "a walk", "dinner", "a call"] as const;
export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;

export const TODOS = [
  "Renew the library card", "Call the plumber about the sink", "Buy birthday card", "Back up the laptop",
  "Book dentist appointment", "Water the plants", "Return the borrowed drill", "Sort the receipts",
  "Pick up dry cleaning", "Update the budget sheet", "Fix the bike tire", "Order printer ink",
] as const;

export const IDEAS = [
  "A map of every coffee shop I have worked from", "Weekly photo walk challenge",
  "Tiny app that reminds me to stretch", "Write a short essay about city birds",
  "Board game night rotation", "Recipe cards for the five dinners I always cook",
  "Learn to bind a notebook", "Podcast about small museums",
] as const;

export const DIARY_OPENERS = [
  "Slow morning today.", "Busy day at work.", "Quiet evening at home.", "Long walk after lunch.",
  "Rainy all day.", "Bright and cold outside.", "Did not sleep well.", "Felt rested for once.",
] as const;

export const DIARY_MIDDLES = [
  "Finished a chapter of the novel I am reading.", "Cooked something new and it mostly worked.",
  "Spent too long on email.", "Had a good conversation with a friend.", "Went climbing and fell a lot.",
  "Cleaned the kitchen properly.", "Made progress on the side project.", "Skipped the gym again.",
] as const;

export const DIARY_CLOSERS = [
  "Grateful for small things.", "Tomorrow should be calmer.", "A bit anxious about the deadline.",
  "Happy with how it went.", "Need to rest more.", "Looking forward to the weekend.",
] as const;

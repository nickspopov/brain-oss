// Types for snowball-stemmers 0.6.0 (the package ships no types of its own).
declare module 'snowball-stemmers' {
  export interface Stemmer {
    stem(word: string): string;
  }
  export function newStemmer(language: string): Stemmer;
  export function algorithms(): string[];
  const snowball: { newStemmer: typeof newStemmer; algorithms: typeof algorithms };
  export default snowball;
}

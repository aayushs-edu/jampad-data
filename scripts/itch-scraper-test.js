import { 
  getGame
 } from 'itch-scraper'

const gameData = async (link) => {
  const game = await getGame(link);
  return { game };
}

console.log(await gameData('https://featurekreep.itch.io/samsara'));
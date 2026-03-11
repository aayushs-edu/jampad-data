const itchy = require("itchy")
async function main(){
    let data = await itchy.getJamData("https://itch.io/jam/pirate17")
    console.log(data)
}
main()
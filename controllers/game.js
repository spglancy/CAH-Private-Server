module.exports = io => {
  const Lobby = require("../models/Lobby")
  const cardWins = require("../models/cardWins")
  const User = require("../models/user")
  io.on("connection", client => {
    client.on("Create AI", name => {
      // create an AI user
      User.create({ name }).then(u => {
        client.emit("Add AI", u)
      })
    })

    client.on("Find Lobby", strId => {
      // find a lobby by name
      Lobby.find({ strId }).then(lobbies => {
        if (lobbies.length > 0) {
          client.emit("Lobby Found", lobbies[0]._id)
        } else {
          client.emit("Lobby Not Found")
        }
      })
    })

    client.on("Create Lobby", (sets, strId, owner, AI) => {
      strId = strId.toLowerCase()
      Lobby.findOne({ strId }).then(lobby => {
        if (lobby) {
          client.emit(
            "Lobby Creation Fail",
            "A lobby with that name already exists"
          )
        } else {
          Lobby.create({
            users: [],
            strId,
            sets,
            gameState: "Idle",
            owner,
            currBlack: null,
            playedWhite: [],
            czar: "",
            creationDate: new Date()
          })
            .then(lobby => {
              // sets the deck for the lobby
              for (let i = 0; i < lobby.sets.length; i++) {
                lobby.blackCards = lobby.blackCards.concat(sets[i].blackCards)
                lobby.whiteCards = lobby.whiteCards.concat(sets[i].whiteCards)
              }
              // adding Ai users to the lobby
              for (let x = 0; x < AI.length; x++) {
                let cards = []
                for (let i = 0; i < 10; i++) {
                  cards.push(
                    lobby.whiteCards.splice(
                      Math.floor(Math.random() * lobby.whiteCards.length),
                      1
                    )[0]
                  )
                }
                lobby.AIUsers.push({
                  name: AI[x].name,
                  id: AI[x]._id,
                  points: 0,
                  czar: false,
                  owner: false,
                  cards,
                  played: false
                })
              }
              lobby
                .save()
                .then(() => {
                  client.emit("Lobby Created", lobby._id)
                })
                .catch(err => console.log(err))
            })
            .catch(err => console.log(err))
        }
      })
    })

    client.on("Join Lobby", (lobbyId, user) => {
      //adds a user to the specified lobby
      client.join(lobbyId)
      Lobby.findById(lobbyId).then(lobby => {
        // sets whether or not the client is the lobby owner
        let owner = false
        if (lobby.owner === user._id) {
          owner = true
        }
        // asserts that the user is not already in the lobby
        if (
          !lobby.users.reduce((me, userCheck) => {
            if (userCheck.id === user._id) {
              return userCheck
            } else {
              return me
            }
          }, null)
        ) {
          // instantiates user's hand and points
          let cards = []
          for (let i = 0; i < 10; i++) {
            cards.push(
              lobby.whiteCards.splice(
                Math.floor(Math.random() * lobby.whiteCards.length),
                1
              )[0]
            )
          }
          lobby.users.push({
            name: user.name,
            id: user._id,
            points: 0,
            czar: false,
            owner,
            cards,
            played: false
          })
        } 
        // saves lobby with new user
        lobby
          .save()
          .then(lobby => {
            io.to(lobbyId).emit("Update Players", lobby)
          })
          .catch(err => console.log(err))
      })
    })

    client.on("Chat Message", (message, username, lobby) => {
      if (username) {
        io.to(lobby).emit("New Message", message, username)
      }
    })

    client.on("Start Game", lobbyId => {
      Lobby.findById(lobbyId).then(lobby => {
        lobby.gameState = "Playing"
        const index = Math.floor(
          Math.random() * lobby.users.length + lobby.AIUsers.length
        )
        if (index < lobby.users.length) {
          lobby.czar = lobby.users[index].id
        } else {
          lobby.czar = lobby.AIUsers[index - lobby.users.length].id
        }

        do {
          lobby.currBlack = lobby.blackCards.splice(
            Math.floor(Math.random() * lobby.blackCards.length),
            1
          )[0]
        } while (lobby.currBlack.pick !== 1) //temp makes sure all black cards are pick 1
        botplay(lobby)
        lobby.save().then(lobby => {
          io.to(lobbyId).emit("Update Players", lobby)
        })
      })
    })

    client.on("Select Winner", (lobbyId, card) => {
      // for some reason its being called numerous times, seems like it might be a frontend issue

      console.log("recieving")
      console.log(card)
      Lobby.findById(lobbyId)
        .then(lobby => {
          winner = lobby.playedWhite.reduce(
            (winner, playedCard) =>
              playedCard.card === card ? playedCard : winner,
            null
          )
          user = lobby.users.reduce(
            (me, user) => (user.id === winner.userId ? user : me),
            null
          )
          user.points += 1
          lobby.hands.unshift({
            user: winner.userId,
            card: card,
            bCard: lobby.currBlack.text
          })
          // AI code to save blackcard win data
          // only issue with this code is the currBlack is NOT the current black card
          cardWins
            .findOne({ blackCard: lobby.currBlack.text })
            .then(bCard => {
              if (bCard) {
                const index = bCard.winningCards.findIndex(i => i.card === card)
                if (index == -1) {
                  bCard.winningCards.push({ card, count: 1 })
                } else {
                  bCard.winningCards[index].count += 1
                }
                bCard.save()
              } else {
                cardWins.create({
                  blackCard: lobby.currBlack.text,
                  winningCards: { card, count: 1 }
                })
              }
              lobby.czar =
                lobby.users[
                  (lobby.users.reduce(
                    (reducer, player, index) =>
                      player.id === lobby.czar ? index : reducer,
                    -1
                  ) +
                    1) %
                    lobby.users.length
                ].id
              lobby.gameState = "Playing"
              do {
                lobby.currBlack = lobby.blackCards.splice(
                  Math.floor(Math.random() * lobby.blackCards.length),
                  1
                )[0]
              } while (lobby.currBlack.pick !== 1) //temp makes sure all black cards are pick 1
              lobby.playedWhite = []
              for (let i = 0; i < lobby.users.length; i++) {
                lobby.users[i].played = false
                lobby.users.set(i, lobby.users[i])
              }
              botplay(lobby)
              lobby.save().then(lobby => {
                Lobby.findByIdAndUpdate(lobbyId, lobby).then(newLobby => {
                  io.to(lobbyId).emit("Winning Card", winner)
                })
              })
            })
            .catch(err => console.log(err))
        })
        .catch(err => console.log(err))
    })

    client.on("Update Lobby", lobbyId => {
      Lobby.findById(lobbyId).then(lobby => {
        client.emit("Update Players", lobby)
      })
    })

    function aiSelect(bCard, lobby) {
      if (bCard != null) {
        let winCount = 0
        const card = lobby.playedWhite.reduce((chosen, card) => {
          const index = bCard.winningCards.findIndex(a => a.card === card)
          if (index != -1) {
            if (bCard.winningCards[index].count > winCount) {
              winCount = bCard.winningCards[index].count
              return card.card
            } else {
              return chosen
            }
          } else {
            return chosen
          }
        }, lobby.playedWhite[0].card)
        console.log("chosenCard")
        console.log(card)
        client.emit("AI Czar", lobby._id, card)
      } else {
        console.log("randCard")
        const card =
          lobby.playedWhite[
            Math.floor(Math.random() * lobby.playedWhite.length)
          ].card
        console.log(card)
        client.emit("AI Czar", lobby._id, card)
      }
    }

    function botplay(lobby) {
      // bot logic
      let called = false
      lobby.users.forEach(bot => {
        if (bot.bot) {
          if (!bot.played) {
            cardWins
              .findOne({ blackCard: lobby.currBlack.text })
              .then(bCard => {
                if (bot.id !== lobby.czar) {
                  if (bCard !== null) {
                    let winCount = 0
                    const chosenCard = bot.cards.reduce((chosen, card) => {
                      const index = bCard.winningCards.findIndex(
                        a => a.card === card
                      )
                      if (index !== -1) {
                        if (bCard.winningCards[index].count > winCount) {
                          winCount = bCard.winningCards[index].count
                          return card
                        } else {
                          return chosen
                        }
                      } else {
                        return chosen
                      }
                    })
                    lobby.playedWhite.push({
                      card: chosenCard,
                      userId: bot.id,
                      name: bot.name
                    })
                    bot.cards.splice(bot.cards.indexOf(chosenCard), 1)
                    bot.cards.push(
                      lobby.whiteCards.splice(
                        Math.floor(Math.random() * lobby.whiteCards.length),
                        (1)[0]
                      )
                    )
                    bot.played = true
                  } else {
                    const index = Math.floor(Math.random() * bot.cards.length)
                    lobby.playedWhite.push({
                      card: bot.cards[index],
                      userId: bot.id,
                      name: bot.name
                    })
                    bot.cards.splice(bot.cards.indexOf(index), 1)
                    bot.cards.push(lobby.whiteCards.splice(index, (1)[0]))
                    bot.played = true
                  }
                } else {
                  if (
                    lobby.playedWhite.length === lobby.users.length - 1 &&
                    called == false
                  ) {
                    aiSelect(bCard, lobby)
                    called = true
                  }
                }
              })
          }
        }
      })
    }

    client.on("Submit Card", (lobbyId, userId, card) => {
      Lobby.findById(lobbyId).then(lobby => {
        const user = lobby.users.reduce((me, user) => {
          if (user.id === userId) {
            return user
          }
          return me
        }, null)
        lobby.playedWhite.push({ card, userId, name: user.name })

        user.cards.splice(user.cards.indexOf(card), 1)
        user.cards.push(
          lobby.whiteCards.splice(
            Math.floor(Math.random() * lobby.whiteCards.length),
            1
          )[0]
        )
        user.played = true
        lobby.save().then(lobby => {
          Lobby.findByIdAndUpdate(lobbyId, lobby).then(newLobby => {
            if (newLobby.playedWhite.length === newLobby.users.length - 1) {
              newLobby.gameState = "Selecting"
              newLobby
                .save()
                .then(io.to(lobbyId).emit("Update Players", newLobby))
            } else {
              io.to(lobbyId).emit("Update Players", lobby)
            }
          })
        })
        let aiCzar = false
        lobby.users.forEach(user => {
          if (user.id === lobby.czar) {
            if (user.isAI) {
              aiCzar = true
            }
          }
        })
        if (lobby.playedWhite.length === lobby.users.length - 1 && aiCzar) {
          aiSelect(bCard, lobby)
          called = true
        }
      })
    })
  })
}

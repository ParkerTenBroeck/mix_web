export const simpleExample = `let
  fib = x:
    if x <= 0 then 0
    else if x == 1 then 1
    else (fib (x - 1)) + (fib (x - 2));
in {
  greeting = "hello from mix",
  answer = 6 * 7,
  values = [1, 2, 3],
  fib = fib,
  fib10 = fib 10,
}`;

export const canvasExample = `{input = {keys}, state = previousState ? false}: let
  random = seed: salt:
    ((seed + 1) * (salt + 17) * 1103 + salt * 7919) % 65521;

  nonZero = value:
    if value == 0 then 1 else value;

  ballCount = 10;
  textSpeed = 4;

  makeBall = seed: index: {
    x = 20 + ((random seed (index * 5 + 0)) % 520);
    y = 20 + ((random seed (index * 5 + 1)) % 200);
    dx = nonZero (((random seed (index * 5 + 2)) % 7) - 3);
    dy = nonZero (((random seed (index * 5 + 3)) % 7) - 3);
    hue = (random seed (index * 5 + 4)) % 360;
  };

  moveBall = {x, y, dx, dy, hue}: let
    nextDx =
      if (x <= 15) || (x >= 545)
      then -dx
      else dx;

    nextDy =
      if (y <= 15) || (y >= 225)
      then -dy
      else dy;
  in {
    dx = nextDx;
    dy = nextDy;
    x = x + nextDx;
    y = y + nextDy;
    hue = (hue + 2) % 360;
  };

  defaultState = {
    started = false;
    waitFrames = 0;
    seed = 0;
    balls = [];
    textX = 40;
    textY = 40;
  };

  startGame = {waitFrames, textX, textY}: {
    started = true;
    waitFrames = waitFrames;
    seed = waitFrames;
    textX = textX;
    textY = textY;
    balls = builtins.mkList (i: makeBall waitFrames i) ballCount;
  };

  keepWaiting = {waitFrames, textX, textY}: {
    started = false;
    waitFrames = waitFrames + 1;
    seed = 0;
    balls = [];
    textX = textX;
    textY = textY;
  };

  movePosition = position: decrease: increase: min: max:
    if decrease then
      if position <= min then min else position - textSpeed
    else if increase then
      if position >= max then max else position + textSpeed
    else
      position;

  updateGame = {waitFrames, seed, balls, textX, textY}: {
    started = true;
    waitFrames = waitFrames;
    seed = seed;
    textX = movePosition textX (keys?a) (keys?d) 8 395;
    textY = movePosition textY (keys?w) (keys?s) 22 195;
    balls = builtins.mkList (i: moveBall balls.\${i}) balls.len;
  };

  advanceState = state@{started}:
    if started
    then updateGame state
    else if keys?" "
    then startGame state
    else keepWaiting state;

  state =
    if previousState == false
    then defaultState
    else advanceState previousState;

  hexDigits = [
    "0", "1", "2", "3",
    "4", "5", "6", "7",
    "8", "9", "a", "b",
    "c", "d", "e", "f"
  ];

  hexDigit = value:
    hexDigits.\${value};

  hexByte = value:
    (hexDigit (value / 16)) +
    (hexDigit (value % 16));

  hueRamp = hue:
    ((hue % 60) * 255) / 60;

  colorFromHue = hue:
    if hue < 60 then
      "#" + (hexByte 255) + (hexByte (hueRamp hue)) + (hexByte 0)
    else if hue < 120 then
      "#" + (hexByte (255 - (hueRamp hue))) + (hexByte 255) + (hexByte 0)
    else if hue < 180 then
      "#" + (hexByte 0) + (hexByte 255) + (hexByte (hueRamp hue))
    else if hue < 240 then
      "#" + (hexByte 0) + (hexByte (255 - (hueRamp hue))) + (hexByte 255)
    else if hue < 300 then
      "#" + (hexByte (hueRamp hue)) + (hexByte 0) + (hexByte 255)
    else
      "#" + (hexByte 255) + (hexByte 0) + (hexByte (255 - (hueRamp hue)));

  drawBall = {x, y, hue}: {
    kind = "circle";
    x = x;
    y = y;
    radius = 15;
    color = colorFromHue hue;
  };

  draw =
    if state.started then
      [
        {
          kind = "clear";
          color = "#0b0d10";
        }
      ]
      + builtins.mkList (i: drawBall state.balls.\${i}) state.balls.len
      + [
        {
          kind = "text";
          x = state.textX;
          y = state.textY;
          text = "Mix canvas loop";
          size = 16;
          color = "#ff9f43";
        },
        {
          kind = "text";
          x = 16;
          y = 225;
          text = "WASD moves the orange text";
          size = 13;
          color = "#858d9c";
        }
      ]
    else
    [
      {
        kind = "clear";
        color = "#0b0d10";
      },
      {
        kind = "text";
        x = 280;
        y = 112;
        text = "Press Space To Start";
        size = 22;
        align = "center";
        color = "#ff9f43";
      },
      {
        kind = "text";
        x = 280;
        y = 142;
        text = "Your timing seeds the simulation";
        size = 13;
        align = "center";
        color = "#858d9c";
      }
    ];
in {
  state = state;
  draw = draw;
}`;

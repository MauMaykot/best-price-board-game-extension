// Dados do botão de busca, desenhados aqui para o painel funcionar sem imagens externas.

const SVG_NS = 'http://www.w3.org/2000/svg';
const DIE_FACES = 6;

const PIPS = {
  1: [[20, 20]],
  2: [[12, 12], [28, 28]],
  3: [[12, 12], [20, 20], [28, 28]],
  4: [[12, 12], [28, 12], [12, 28], [28, 28]],
  5: [[12, 12], [28, 12], [20, 20], [12, 28], [28, 28]],
  6: [[12, 11], [28, 11], [12, 20], [28, 20], [12, 29], [28, 29]],
};

// O turno vira a soma das faces: 7 é 6 + 1, 13 é 6 + 6 + 1.
export function diceFaces(turn) {
  const faces = new Array(Math.floor(turn / DIE_FACES)).fill(DIE_FACES);
  return turn % DIE_FACES > 0 ? [...faces, turn % DIE_FACES] : faces;
}

export function renderDie(face) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 40 40');
  svg.setAttribute('class', 'die');
  svg.setAttribute('aria-hidden', 'true');

  const body = document.createElementNS(SVG_NS, 'rect');
  for (const [name, value] of Object.entries({ x: 3, y: 3, width: 34, height: 34, rx: 5, class: 'die-body' })) {
    body.setAttribute(name, value);
  }
  svg.append(body);

  for (const [cx, cy] of PIPS[face]) {
    const pip = document.createElementNS(SVG_NS, 'circle');
    pip.setAttribute('cx', cx);
    pip.setAttribute('cy', cy);
    pip.setAttribute('r', 3);
    pip.setAttribute('class', 'die-pip');
    svg.append(pip);
  }
  return svg;
}
